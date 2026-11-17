import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.AWS_REGION = 'ap-southeast-1';
process.env.ASSESSMENT_BUCKET_NAME = 'test-assessment-bucket';

/**
 * Mock shaped after `s3Cache.test.ts`: behaviour is driven by mutable module-level state rather
 * than per-test `mockReset()`/`mockRejectedValue()`, since `approval-service.ts` catches every S3
 * error itself and a rejected mock implementation trips vitest's unhandled-rejection detector even
 * when the code under test does handle it.
 */
type Behaviour =
  | { kind: 'get'; body: string | undefined }
  | { kind: 'list'; keys: string[] }
  | { kind: 'throw'; name: string }
  | { kind: 'ok' };
let behaviour: Behaviour = { kind: 'ok' };
const putInputs: Record<string, unknown>[] = [];
const getInputs: Record<string, unknown>[] = [];

const s3SendMock = vi.fn(async (command: unknown) => {
  const cmd = command as { __type: string; input: Record<string, unknown> };
  if (behaviour.kind === 'throw') {
    const err = new Error(behaviour.name);
    err.name = behaviour.name;
    throw err;
  }
  if (cmd.__type === 'putObject') {
    putInputs.push(cmd.input);
    return {};
  }
  if (cmd.__type === 'getObject') {
    getInputs.push(cmd.input);
    const current = behaviour;
    if (current.kind === 'get') {
      const body = current.body;
      return { Body: body === undefined ? undefined : { transformToString: async () => body } };
    }
    return { Body: undefined };
  }
  if (cmd.__type === 'listObjectsV2') {
    if (behaviour.kind === 'list') {
      return { Contents: behaviour.keys.map((key) => ({ Key: key })) };
    }
    return { Contents: [] };
  }
  return {};
});

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: s3SendMock })),
  GetObjectCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'getObject', input })),
  PutObjectCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'putObject', input })),
  ListObjectsV2Command: vi.fn().mockImplementation((input: unknown) => ({ __type: 'listObjectsV2', input })),
}));

const { createApprovalRequest, getApproval, listApprovals, decideApproval, markApprovalExecuted } = await import(
  './approval-service.js'
);

beforeEach(() => {
  behaviour = { kind: 'ok' };
  putInputs.length = 0;
  getInputs.length = 0;
  s3SendMock.mockClear();
});

const baseInput = {
  actionType: 'ElasticIp_Release' as const,
  resourceId: 'eipalloc-abc',
  region: 'ap-southeast-1',
  params: {},
  requestedReason: 'No longer needed',
  requestedBy: 'requester@example.com',
};

describe('createApprovalRequest', () => {
  it('writes a new pending ApprovalRequest to S3 with the input fields', async () => {
    const result = await createApprovalRequest(baseInput);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.approval.status).toBe('pending');
    expect(result.approval.actionType).toBe('ElasticIp_Release');
    expect(result.approval.resourceId).toBe('eipalloc-abc');
    expect(result.approval.requestedBy).toBe('requester@example.com');
    expect(result.approval.id).toBeTruthy();
    expect(result.approval.requestedAt).toBeTruthy();

    expect(putInputs).toHaveLength(1);
    expect(putInputs[0]).toMatchObject({ Bucket: 'test-assessment-bucket', ContentType: 'application/json' });
    expect((putInputs[0].Key as string).startsWith('approvals/')).toBe(true);
  });

  it('returns { ok: false } (never throws) when the S3 write fails', async () => {
    behaviour = { kind: 'throw', name: 'AccessDenied' };

    const result = await createApprovalRequest(baseInput);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toBeTruthy();
  });
});

describe('getApproval', () => {
  it('parses and returns the stored ApprovalRequest by id', async () => {
    const stored = { ...baseInput, id: 'abc-1', requestedAt: '2026-01-01T00:00:00.000Z', status: 'pending' };
    behaviour = { kind: 'get', body: JSON.stringify(stored) };

    await expect(getApproval('abc-1')).resolves.toEqual(stored);
  });

  it('returns undefined (never throws) when the object is missing', async () => {
    behaviour = { kind: 'throw', name: 'NoSuchKey' };
    await expect(getApproval('missing-id')).resolves.toBeUndefined();
  });

  it('returns undefined (never throws) when the content is corrupt JSON', async () => {
    behaviour = { kind: 'get', body: 'not json' };
    await expect(getApproval('corrupt-id')).resolves.toBeUndefined();
  });
});

describe('listApprovals', () => {
  it('returns [] (never throws) when ListObjectsV2 fails', async () => {
    behaviour = { kind: 'throw', name: 'AccessDenied' };
    await expect(listApprovals()).resolves.toEqual([]);
  });

  it('returns [] when there are no records', async () => {
    behaviour = { kind: 'list', keys: [] };
    await expect(listApprovals()).resolves.toEqual([]);
  });
});

describe('decideApproval', () => {
  it('returns { ok: false } when the approval request does not exist', async () => {
    behaviour = { kind: 'throw', name: 'NoSuchKey' };
    const result = await decideApproval('missing-id', 'approver@example.com', 'approved');
    expect(result.ok).toBe(false);
  });

  it('returns { ok: false } when the request is not pending', async () => {
    const stored = { ...baseInput, id: 'abc-1', requestedAt: '2026-01-01T00:00:00.000Z', status: 'approved' };
    behaviour = { kind: 'get', body: JSON.stringify(stored) };

    const result = await decideApproval('abc-1', 'approver@example.com', 'approved');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toMatch(/not pending/);
  });

  it('SECURITY: rejects when decidedBy is the SAME identity as requestedBy (maker != checker), even case-insensitively', async () => {
    const stored = { ...baseInput, id: 'abc-1', requestedAt: '2026-01-01T00:00:00.000Z', status: 'pending' };
    behaviour = { kind: 'get', body: JSON.stringify(stored) };

    const result = await decideApproval('abc-1', 'REQUESTER@EXAMPLE.COM', 'approved');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toMatch(/cannot decide their own/);
    expect(putInputs).toHaveLength(0);
  });

  it('requires a non-empty decisionReason when rejecting', async () => {
    const stored = { ...baseInput, id: 'abc-1', requestedAt: '2026-01-01T00:00:00.000Z', status: 'pending' };
    behaviour = { kind: 'get', body: JSON.stringify(stored) };

    const result = await decideApproval('abc-1', 'approver@example.com', 'rejected');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toMatch(/decisionReason is required/);
  });

  it('approves a pending request from a DIFFERENT identity and writes the decision', async () => {
    const stored = { ...baseInput, id: 'abc-1', requestedAt: '2026-01-01T00:00:00.000Z', status: 'pending' };
    behaviour = { kind: 'get', body: JSON.stringify(stored) };

    const result = await decideApproval('abc-1', 'approver@example.com', 'approved');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.approval.status).toBe('approved');
    expect(result.approval.decidedBy).toBe('approver@example.com');
    expect(result.approval.decidedAt).toBeTruthy();
    expect(putInputs).toHaveLength(1);
  });
});

describe('markApprovalExecuted', () => {
  it('returns { ok: false } when the request is not approved', async () => {
    const stored = { ...baseInput, id: 'abc-1', requestedAt: '2026-01-01T00:00:00.000Z', status: 'pending' };
    behaviour = { kind: 'get', body: JSON.stringify(stored) };

    const result = await markApprovalExecuted('abc-1');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toMatch(/not approved/);
  });

  it('returns { ok: false } when the approved request has expired (decidedAt beyond APPROVAL_VALID_FOR_MS)', async () => {
    const stored = {
      ...baseInput,
      id: 'abc-1',
      requestedAt: '2020-01-01T00:00:00.000Z',
      status: 'approved',
      decidedBy: 'approver@example.com',
      decidedAt: '2020-01-01T00:00:00.000Z',
    };
    behaviour = { kind: 'get', body: JSON.stringify(stored) };

    const result = await markApprovalExecuted('abc-1');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toMatch(/expired/);
  });

  it('marks a valid approved request as executed', async () => {
    const stored = {
      ...baseInput,
      id: 'abc-1',
      requestedAt: '2026-01-01T00:00:00.000Z',
      status: 'approved',
      decidedBy: 'approver@example.com',
      decidedAt: new Date().toISOString(),
    };
    behaviour = { kind: 'get', body: JSON.stringify(stored) };

    const result = await markApprovalExecuted('abc-1');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.approval.status).toBe('executed');
    expect(result.approval.executedAt).toBeTruthy();
  });
});
