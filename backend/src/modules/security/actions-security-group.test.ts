import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildMockAppConfig } from '../../shared-kernel/testHelpers.js';

vi.mock('../../config.js', () => ({
  config: buildMockAppConfig(),
  corsHeaders: () => ({}),
}));

const isOperatorMemberMock = vi.fn();
vi.mock('../web/index.js', () => ({
  isOperatorMember: (claims: Record<string, unknown>) => isOperatorMemberMock(claims),
}));

const lambdaSendMock = vi.fn();
vi.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: vi.fn().mockImplementation(() => ({ send: lambdaSendMock })),
  InvokeCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
}));

const { handler } = await import('./actions-security-group.js');

const VALID_RULE = { protocol: 'tcp', fromPort: 443, toPort: 443, cidrIp: '10.0.0.0/16' };

function buildEvent(body: unknown): any {
  return {
    headers: {},
    rawPath: '/actions/security-group',
    requestContext: { http: { method: 'POST' } },
    body: JSON.stringify(body),
  };
}

/** The actual payload sent to action-execution-fn, decoded from the InvokeCommand argument. */
function invokedRequest(): any {
  const command = lambdaSendMock.mock.calls[0][0] as { input: { Payload: Buffer } };
  return JSON.parse(Buffer.from(command.input.Payload).toString('utf-8'));
}

beforeEach(() => {
  isOperatorMemberMock.mockReset();
  lambdaSendMock.mockReset();
});

describe('handler (POST /actions/security-group)', () => {
  it('throws 403 when claims do NOT belong to the operator group — BEFORE any side effect', async () => {
    isOperatorMemberMock.mockReturnValue(false);

    await expect(
      handler(
        buildEvent({ actionType: 'SecurityGroup_AuthorizeIngress', resourceId: 'sg-0123abcd', params: VALID_RULE }),
        { sub: 'user-1' },
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(lambdaSendMock).not.toHaveBeenCalled();
  });

  it('throws 403 even when the body is malformed — the gate runs before body parsing', async () => {
    isOperatorMemberMock.mockReturnValue(false);

    const event = buildEvent({});
    event.body = '{ not-json';

    await expect(handler(event, { sub: 'user-1' })).rejects.toMatchObject({ statusCode: 403 });
    expect(lambdaSendMock).not.toHaveBeenCalled();
  });

  it('throws 400 when actionType is not one of the 2 Security Group actions', async () => {
    isOperatorMemberMock.mockReturnValue(true);

    await expect(
      handler(buildEvent({ actionType: 'EC2_Start', resourceId: 'sg-0123abcd', params: VALID_RULE }), {
        sub: 'user-1',
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(lambdaSendMock).not.toHaveBeenCalled();
  });

  it('throws 400 when resourceId does not match the sg-... format', async () => {
    isOperatorMemberMock.mockReturnValue(true);

    await expect(
      handler(
        buildEvent({ actionType: 'SecurityGroup_AuthorizeIngress', resourceId: 'i-0123abcd', params: VALID_RULE }),
        { sub: 'user-1' },
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(lambdaSendMock).not.toHaveBeenCalled();
  });

  it('throws 400 when the CIDR is invalid — without spending a Lambda invocation', async () => {
    isOperatorMemberMock.mockReturnValue(true);

    await expect(
      handler(
        buildEvent({
          actionType: 'SecurityGroup_AuthorizeIngress',
          resourceId: 'sg-0123abcd',
          params: { ...VALID_RULE, cidrIp: '10.0.0.1/16' },
        }),
        { sub: 'user-1' },
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(lambdaSendMock).not.toHaveBeenCalled();
  });

  it('throws 400 when the port is outside the 0..65535 range', async () => {
    isOperatorMemberMock.mockReturnValue(true);

    await expect(
      handler(
        buildEvent({
          actionType: 'SecurityGroup_AuthorizeIngress',
          resourceId: 'sg-0123abcd',
          params: { ...VALID_RULE, fromPort: 70000, toPort: 70000 },
        }),
        { sub: 'user-1' },
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(lambdaSendMock).not.toHaveBeenCalled();
  });

  it('invokes action-execution-fn with params ALREADY normalized (integers, not strings from the form)', async () => {
    isOperatorMemberMock.mockReturnValue(true);
    lambdaSendMock.mockResolvedValue({
      Payload: Buffer.from(JSON.stringify({ outcome: 'success', appliedSecurityGroupRule: 'OPEN tcp 443' })),
    });

    const res = (await handler(
      buildEvent({
        actionType: 'SecurityGroup_AuthorizeIngress',
        resourceId: 'sg-0123abcd',
        // The form sends strings — the handler must normalize to numbers before audit/execution.
        params: { protocol: 'tcp', fromPort: '443', toPort: '443', cidrIp: '10.0.0.0/16' },
      }),
      { sub: 'user-1', preferred_username: 'operator@example.com' },
    )) as { statusCode: number; body: string };

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ outcome: 'success', appliedSecurityGroupRule: 'OPEN tcp 443' });
    expect(invokedRequest()).toEqual({
      actionType: 'SecurityGroup_AuthorizeIngress',
      resourceId: 'sg-0123abcd',
      region: 'ap-southeast-1',
      params: { protocol: 'tcp', fromPort: 443, toPort: 443, cidrIp: '10.0.0.0/16' },
      executedBy: 'operator@example.com',
    });
  });

  it('removing a rule (Revoke) also follows the correct path and preserves actionType', async () => {
    isOperatorMemberMock.mockReturnValue(true);
    lambdaSendMock.mockResolvedValue({ Payload: Buffer.from(JSON.stringify({ outcome: 'success' })) });

    await handler(
      buildEvent({ actionType: 'SecurityGroup_RevokeIngress', resourceId: 'sg-0123abcd', params: VALID_RULE }),
      { sub: 'user-1' },
    );

    expect(invokedRequest().actionType).toBe('SecurityGroup_RevokeIngress');
  });

  it('throws 502 when action-execution-fn returns FunctionError', async () => {
    isOperatorMemberMock.mockReturnValue(true);
    lambdaSendMock.mockResolvedValue({ Payload: Buffer.from('{}'), FunctionError: 'Unhandled' });

    await expect(
      handler(
        buildEvent({ actionType: 'SecurityGroup_AuthorizeIngress', resourceId: 'sg-0123abcd', params: VALID_RULE }),
        { sub: 'user-1' },
      ),
    ).rejects.toMatchObject({ statusCode: 502 });
  });
});
