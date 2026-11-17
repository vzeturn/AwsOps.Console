import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.AWS_REGION = 'ap-southeast-1';
process.env.AWS_ACCOUNT_ID = '123456789012';
process.env.ASSESSMENT_BUCKET_NAME = 'test-assessment-bucket';
process.env.ENTRA_TENANT_ID = 'tenant';
process.env.ENTRA_CLIENT_ID = 'client';
process.env.EC2_STATE_MANAGER_SERVICE_TOKEN_PARAM_NAME = '/x';
process.env.EC2_STATE_MANAGER_FUNCTION_URL = 'https://x.invalid/';
process.env.ACTION_EXECUTION_FUNCTION_NAME = 'fn';
process.env.SCHEDULED_ACTIONS_MUTATE_FUNCTION_NAME = 'fn2';
process.env.APPROVAL_MUTATE_FUNCTION_NAME = 'fn3';
process.env.IDLE_SCHEDULER_MUTATE_FUNCTION_NAME = 'fn4';

/**
 * Mock shaped after `threshold-history-service.property12.test.ts`: the behaviour is driven by mutable
 * module-level state and the implementation is passed straight into `vi.fn()`, rather than being
 * swapped per-test with `mockReset()` + `mockRejectedValue()`. The latter made vitest surface the
 * rejection as an unhandled error even though `s3Cache` catches it.
 */
type Behaviour = { kind: 'body'; body: string } | { kind: 'throw'; name: string } | { kind: 'ok' };
let behaviour: Behaviour = { kind: 'ok' };
const putInputs: Record<string, unknown>[] = [];

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
  if (behaviour.kind === 'body') {
    return { Body: { transformToString: async () => behaviour.kind === 'body' && behaviour.body } };
  }
  return {};
});

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: s3SendMock })),
  GetObjectCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'getObject', input })),
  PutObjectCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'putObject', input })),
}));

const { readCachedJson, writeCachedJson } = await import('./s3Cache.js');

beforeEach(() => {
  behaviour = { kind: 'ok' };
  putInputs.length = 0;
  s3SendMock.mockClear();
});

describe('readCachedJson', () => {
  it('parses the stored JSON', async () => {
    behaviour = { kind: 'body', body: '{"a":1}' };
    await expect(readCachedJson<{ a: number }>('k.json')).resolves.toEqual({ a: 1 });
  });

  it('returns undefined (never throws) when the object is missing', async () => {
    behaviour = { kind: 'throw', name: 'NoSuchKey' };
    await expect(readCachedJson('k.json')).resolves.toBeUndefined();
  });

  it('returns undefined (never throws) when the content is corrupt', async () => {
    behaviour = { kind: 'body', body: 'not json' };
    await expect(readCachedJson('k.json')).resolves.toBeUndefined();
  });
});

describe('writeCachedJson', () => {
  it('writes the object as JSON under the given key', async () => {
    await writeCachedJson('monitoring-cache.json', { hello: 'world' });

    expect(putInputs).toHaveLength(1);
    expect(putInputs[0]).toMatchObject({
      Key: 'monitoring-cache.json',
      Bucket: 'test-assessment-bucket',
      Body: '{"hello":"world"}',
      ContentType: 'application/json',
    });
  });

  /**
   * The contract `modules/monitoring/get-monitoring.ts` depends on: it awaits this write AFTER it already has a
   * response to return, so a throw here would convert a working request into a 500 purely because a
   * cost optimisation could not be persisted.
   */
  it('NEVER throws when S3 rejects — the caller already holds a valid response', async () => {
    behaviour = { kind: 'throw', name: 'AccessDenied' };
    await expect(writeCachedJson('monitoring-cache.json', { a: 1 })).resolves.toBeUndefined();
  });
});
