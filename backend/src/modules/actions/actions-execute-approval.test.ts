import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../config.js', () => ({
  config: {
    allowedOrigins: [],
    awsRegion: 'ap-southeast-1',
    actionExecutionFunctionName: 'test-action-execution-fn',
    approvalMutateFunctionName: 'test-approval-mutate-fn',
  },
  corsHeaders: () => ({}),
}));

const getApprovalMock = vi.fn();
vi.mock('./approval-service.js', () => ({
  getApproval: (...args: unknown[]) => getApprovalMock(...args),
}));

const lambdaSendMock = vi.fn();
vi.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: vi.fn().mockImplementation(() => ({ send: lambdaSendMock })),
  InvokeCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
}));

const { handler } = await import('./actions-execute-approval.js');

function buildEvent(body: unknown): any {
  return { headers: {}, rawPath: '/actions/execute-approval', requestContext: { http: { method: 'POST' } }, body: JSON.stringify(body) };
}

function approvedRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'a1',
    actionType: 'ElasticIp_Release',
    resourceId: 'eipalloc-1',
    region: 'ap-southeast-1',
    params: {},
    requestedReason: 'no longer needed',
    requestedBy: 'requester@example.com',
    requestedAt: '2026-01-01T00:00:00.000Z',
    status: 'approved',
    decidedBy: 'approver@example.com',
    decidedAt: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  getApprovalMock.mockReset();
  lambdaSendMock.mockReset();
});

describe('handler (POST /actions/execute-approval)', () => {
  it('throws 400 when id is missing', async () => {
    await expect(handler(buildEvent({}), { sub: 'x' })).rejects.toMatchObject({ statusCode: 400 });
    expect(lambdaSendMock).not.toHaveBeenCalled();
  });

  it('throws 400 when the approval request does not exist', async () => {
    getApprovalMock.mockResolvedValue(undefined);
    await expect(handler(buildEvent({ id: 'missing' }), { sub: 'x' })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('throws 400 when the approval is not in approved status', async () => {
    getApprovalMock.mockResolvedValue(approvedRecord({ status: 'pending' }));
    await expect(handler(buildEvent({ id: 'a1' }), { sub: 'x' })).rejects.toMatchObject({ statusCode: 400 });
    expect(lambdaSendMock).not.toHaveBeenCalled();
  });

  it('throws 400 when the approval has expired', async () => {
    getApprovalMock.mockResolvedValue(approvedRecord({ decidedAt: '2020-01-01T00:00:00.000Z' }));
    await expect(handler(buildEvent({ id: 'a1' }), { sub: 'x' })).rejects.toMatchObject({ statusCode: 400 });
    expect(lambdaSendMock).not.toHaveBeenCalled();
  });

  it('SECURITY: throws 403 when the caller is NEITHER the requester NOR the approver', async () => {
    getApprovalMock.mockResolvedValue(approvedRecord());
    const outsider = { sub: 'z', preferred_username: 'someone-else@example.com' };

    await expect(handler(buildEvent({ id: 'a1' }), outsider)).rejects.toMatchObject({ statusCode: 403 });
    expect(lambdaSendMock).not.toHaveBeenCalled();
  });

  it('allows the ORIGINAL REQUESTER to execute, invokes action-execution-fn then marks executed on success', async () => {
    getApprovalMock.mockResolvedValue(approvedRecord());
    lambdaSendMock
      .mockResolvedValueOnce({ Payload: Buffer.from(JSON.stringify({ outcome: 'success' })) })
      .mockResolvedValueOnce({ Payload: Buffer.from(JSON.stringify({ ok: true, approval: approvedRecord({ status: 'executed' }) })) });

    const requester = { sub: 'y', preferred_username: 'requester@example.com' };
    const res = await handler(buildEvent({ id: 'a1' }), requester);

    const typedRes = res as { statusCode: number; body: string };
    expect(typedRes.statusCode).toBe(200);
    expect(JSON.parse(typedRes.body)).toEqual({ outcome: 'success' });
    expect(lambdaSendMock).toHaveBeenCalledTimes(2);

    const markExecutedCall = lambdaSendMock.mock.calls[1][0] as { input: { Payload: Buffer } };
    const sentEvent = JSON.parse(markExecutedCall.input.Payload.toString());
    expect(sentEvent).toEqual({ kind: 'mark-executed', id: 'a1' });
  });

  it('allows the APPROVER to execute', async () => {
    getApprovalMock.mockResolvedValue(approvedRecord());
    lambdaSendMock
      .mockResolvedValueOnce({ Payload: Buffer.from(JSON.stringify({ outcome: 'success' })) })
      .mockResolvedValueOnce({ Payload: Buffer.from(JSON.stringify({ ok: true, approval: approvedRecord({ status: 'executed' }) })) });

    const approver = { sub: 'w', preferred_username: 'approver@example.com' };
    const res = await handler(buildEvent({ id: 'a1' }), approver);

    expect((res as { statusCode: number }).statusCode).toBe(200);
  });

  it('does NOT invoke mark-executed when action-execution-fn reports a non-success outcome', async () => {
    getApprovalMock.mockResolvedValue(approvedRecord());
    lambdaSendMock.mockResolvedValueOnce({ Payload: Buffer.from(JSON.stringify({ outcome: 'failure', error: 'boom' })) });

    const requester = { sub: 'y', preferred_username: 'requester@example.com' };
    const res = await handler(buildEvent({ id: 'a1' }), requester);

    expect((res as { statusCode: number }).statusCode).toBe(200);
    expect(lambdaSendMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT surface an error to the caller when only the mark-executed bookkeeping call fails', async () => {
    getApprovalMock.mockResolvedValue(approvedRecord());
    lambdaSendMock
      .mockResolvedValueOnce({ Payload: Buffer.from(JSON.stringify({ outcome: 'success' })) })
      .mockRejectedValueOnce(new Error('mark-executed invoke failed'));

    const requester = { sub: 'y', preferred_username: 'requester@example.com' };
    const res = await handler(buildEvent({ id: 'a1' }), requester);

    const typedRes = res as { statusCode: number; body: string };
    expect(typedRes.statusCode).toBe(200);
    expect(JSON.parse(typedRes.body)).toEqual({ outcome: 'success' });
  });
});
