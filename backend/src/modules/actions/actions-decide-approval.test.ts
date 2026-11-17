import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../config.js', () => ({
  config: {
    allowedOrigins: [],
    awsRegion: 'ap-southeast-1',
    approvalMutateFunctionName: 'test-approval-mutate-fn',
  },
  corsHeaders: () => ({}),
}));

const isOperatorMemberMock = vi.fn();
vi.mock('../web/auth.js', () => ({
  isOperatorMember: (claims: Record<string, unknown>) => isOperatorMemberMock(claims),
}));

const lambdaSendMock = vi.fn();
vi.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: vi.fn().mockImplementation(() => ({ send: lambdaSendMock })),
  InvokeCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
}));

const { handler } = await import('./actions-decide-approval.js');

function buildEvent(body: unknown): any {
  return { headers: {}, rawPath: '/actions/decide-approval', requestContext: { http: { method: 'POST' } }, body: JSON.stringify(body) };
}

const approverClaims = { sub: 'user-2', preferred_username: 'approver@example.com' };

beforeEach(() => {
  isOperatorMemberMock.mockReset();
  lambdaSendMock.mockReset();
});

describe('handler (POST /actions/decide-approval)', () => {
  it('throws 403 when claims are NOT in the operator group — segregation of duties requires an elevated checker', async () => {
    isOperatorMemberMock.mockReturnValue(false);

    await expect(
      handler(buildEvent({ id: 'a1', decision: 'approved' }), approverClaims),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(lambdaSendMock).not.toHaveBeenCalled();
  });

  it('throws 400 when id is missing', async () => {
    isOperatorMemberMock.mockReturnValue(true);
    await expect(handler(buildEvent({ decision: 'approved' }), approverClaims)).rejects.toMatchObject({ statusCode: 400 });
  });

  it("throws 400 when decision is not 'approved'/'rejected'", async () => {
    isOperatorMemberMock.mockReturnValue(true);
    await expect(handler(buildEvent({ id: 'a1', decision: 'maybe' }), approverClaims)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('throws 400 when rejecting without a decisionReason', async () => {
    isOperatorMemberMock.mockReturnValue(true);
    await expect(handler(buildEvent({ id: 'a1', decision: 'rejected' }), approverClaims)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('invokes approval-mutate-fn with kind decide and the resolved decidedBy, returns the updated approval', async () => {
    isOperatorMemberMock.mockReturnValue(true);
    lambdaSendMock.mockResolvedValue({
      Payload: Buffer.from(JSON.stringify({ ok: true, approval: { id: 'a1', status: 'approved' } })),
    });

    const res = await handler(buildEvent({ id: 'a1', decision: 'approved' }), approverClaims);

    const typedRes = res as { statusCode: number; body: string };
    expect(typedRes.statusCode).toBe(200);
    expect(JSON.parse(typedRes.body)).toEqual({ id: 'a1', status: 'approved' });

    const invoked = lambdaSendMock.mock.calls[0][0] as { input: { Payload: Buffer } };
    const sentEvent = JSON.parse(invoked.input.Payload.toString());
    expect(sentEvent).toMatchObject({ kind: 'decide', id: 'a1', decidedBy: 'approver@example.com', decision: 'approved' });
  });

  it('throws 400 (not 502) when the service result is { ok: false } — e.g. maker == checker', async () => {
    isOperatorMemberMock.mockReturnValue(true);
    lambdaSendMock.mockResolvedValue({
      Payload: Buffer.from(JSON.stringify({ ok: false, error: 'The requester cannot decide their own approval request' })),
    });

    await expect(handler(buildEvent({ id: 'a1', decision: 'approved' }), approverClaims)).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it('throws 502 when approval-mutate-fn returns a FunctionError', async () => {
    isOperatorMemberMock.mockReturnValue(true);
    lambdaSendMock.mockResolvedValue({ Payload: Buffer.from('{}'), FunctionError: 'Unhandled' });

    await expect(handler(buildEvent({ id: 'a1', decision: 'approved' }), approverClaims)).rejects.toMatchObject({
      statusCode: 502,
    });
  });
});
