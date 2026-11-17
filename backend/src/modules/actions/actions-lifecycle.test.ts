import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../config.js', () => ({
  config: {
    allowedOrigins: [],
    entraTenantId: 'test-tenant',
    entraClientId: 'test-client',
    allowedGroupIds: [],
    operatorGroupIds: ['operator-group-1'],
    awsRegion: 'ap-southeast-1',
    actionExecutionFunctionName: 'test-action-execution-fn',
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

const { handler } = await import('./actions-lifecycle.js');

function buildEvent(body: unknown): any {
  return { headers: {}, rawPath: '/actions/lifecycle', requestContext: { http: { method: 'POST' } }, body: JSON.stringify(body) };
}

beforeEach(() => {
  isOperatorMemberMock.mockReset();
  lambdaSendMock.mockReset();
});

describe('handler (POST /actions/lifecycle)', () => {
  it('throws 403 when claims are NOT in the operator group', async () => {
    isOperatorMemberMock.mockReturnValue(false);

    await expect(handler(buildEvent({ actionType: 'EC2_Reboot', resourceId: 'i-abc' }), { sub: 'user-1' })).rejects.toMatchObject({ statusCode: 403 });
    expect(lambdaSendMock).not.toHaveBeenCalled();
  });

  it('throws 400 when actionType is not one of the 4 lifecycle actions', async () => {
    isOperatorMemberMock.mockReturnValue(true);

    await expect(handler(buildEvent({ actionType: 'EC2_Start', resourceId: 'i-abc' }), { sub: 'user-1' })).rejects.toMatchObject({ statusCode: 400 });
    expect(lambdaSendMock).not.toHaveBeenCalled();
  });

  it('throws 400 when resourceId is missing', async () => {
    isOperatorMemberMock.mockReturnValue(true);

    await expect(handler(buildEvent({ actionType: 'EC2_Reboot' }), { sub: 'user-1' })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('invokes ActionExecutionFunction and returns its result when operator + actionType are valid', async () => {
    isOperatorMemberMock.mockReturnValue(true);
    lambdaSendMock.mockResolvedValue({
      Payload: Buffer.from(JSON.stringify({ outcome: 'success', newState: 'rebooting' })),
    });

    const res = await handler(
      buildEvent({ actionType: 'EC2_Reboot', resourceId: 'i-abc', region: 'ap-southeast-1' }),
      { sub: 'user-1', preferred_username: 'operator@example.com' },
    );

    const typedRes = res as { statusCode: number; body: string };
    expect(typedRes.statusCode).toBe(200);
    expect(JSON.parse(typedRes.body)).toEqual({ outcome: 'success', newState: 'rebooting' });
    expect(lambdaSendMock).toHaveBeenCalledTimes(1);
  });

  it('throws 502 when ActionExecutionFunction returns a FunctionError', async () => {
    isOperatorMemberMock.mockReturnValue(true);
    lambdaSendMock.mockResolvedValue({ Payload: Buffer.from('{}'), FunctionError: 'Unhandled' });

    await expect(handler(buildEvent({ actionType: 'RDS_Start', resourceId: 'db-1' }), { sub: 'user-1' })).rejects.toMatchObject({ statusCode: 502 });
  });
});
