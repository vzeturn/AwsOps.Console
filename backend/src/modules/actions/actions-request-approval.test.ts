import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../config.js', () => ({
  config: {
    allowedOrigins: [],
    awsRegion: 'ap-southeast-1',
    approvalMutateFunctionName: 'test-approval-mutate-fn',
  },
  corsHeaders: () => ({}),
}));

const lambdaSendMock = vi.fn();
vi.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: vi.fn().mockImplementation(() => ({ send: lambdaSendMock })),
  InvokeCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
}));

const { handler } = await import('./actions-request-approval.js');

function buildEvent(body: unknown): any {
  return { headers: {}, rawPath: '/actions/request-approval', requestContext: { http: { method: 'POST' } }, body: JSON.stringify(body) };
}

const claims = { sub: 'user-1', preferred_username: 'requester@example.com' };

beforeEach(() => {
  lambdaSendMock.mockReset();
});

describe('handler (POST /actions/request-approval)', () => {
  it('throws 400 when actionType is missing or not in ACTION_CATALOG', async () => {
    await expect(handler(buildEvent({ actionType: 'Nonexistent', resourceId: 'x', requestedReason: 'r' }), claims)).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(lambdaSendMock).not.toHaveBeenCalled();
  });

  it('throws 400 when actionType does NOT require approval (e.g. EC2_Start)', async () => {
    await expect(
      handler(buildEvent({ actionType: 'EC2_Start', resourceId: 'i-abc', requestedReason: 'r' }), claims),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(lambdaSendMock).not.toHaveBeenCalled();
  });

  it('throws 400 when requestedReason is missing/blank', async () => {
    await expect(
      handler(buildEvent({ actionType: 'ElasticIp_Release', resourceId: 'eipalloc-1', requestedReason: '   ' }), claims),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(lambdaSendMock).not.toHaveBeenCalled();
  });

  it('throws 400 when resourceId is missing', async () => {
    await expect(
      handler(buildEvent({ actionType: 'ElasticIp_Release', requestedReason: 'no longer needed' }), claims),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('invokes approval-mutate-fn with kind create and the resolved requestedBy, returns the created approval', async () => {
    lambdaSendMock.mockResolvedValue({
      Payload: Buffer.from(JSON.stringify({ ok: true, approval: { id: 'a1', status: 'pending' } })),
    });

    const res = await handler(
      buildEvent({ actionType: 'ElasticIp_Release', resourceId: 'eipalloc-1', requestedReason: 'no longer needed' }),
      claims,
    );

    const typedRes = res as { statusCode: number; body: string };
    expect(typedRes.statusCode).toBe(200);
    expect(JSON.parse(typedRes.body)).toEqual({ id: 'a1', status: 'pending' });

    expect(lambdaSendMock).toHaveBeenCalledTimes(1);
    const invoked = lambdaSendMock.mock.calls[0][0] as { input: { Payload: Buffer; FunctionName: string } };
    expect(invoked.input.FunctionName).toBe('test-approval-mutate-fn');
    const sentEvent = JSON.parse(invoked.input.Payload.toString());
    expect(sentEvent).toMatchObject({
      kind: 'create',
      actionType: 'ElasticIp_Release',
      resourceId: 'eipalloc-1',
      requestedReason: 'no longer needed',
      requestedBy: 'requester@example.com',
    });
  });

  it('throws 502 when approval-mutate-fn returns a FunctionError', async () => {
    lambdaSendMock.mockResolvedValue({ Payload: Buffer.from('{}'), FunctionError: 'Unhandled' });

    await expect(
      handler(buildEvent({ actionType: 'ElasticIp_Release', resourceId: 'eipalloc-1', requestedReason: 'r' }), claims),
    ).rejects.toMatchObject({ statusCode: 502 });
  });

  it('throws 502 when the service result is { ok: false }', async () => {
    lambdaSendMock.mockResolvedValue({ Payload: Buffer.from(JSON.stringify({ ok: false, error: 'boom' })) });

    await expect(
      handler(buildEvent({ actionType: 'ElasticIp_Release', resourceId: 'eipalloc-1', requestedReason: 'r' }), claims),
    ).rejects.toMatchObject({ statusCode: 502 });
  });
});
