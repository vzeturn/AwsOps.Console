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

const lambdaSendMock = vi.fn();
vi.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: vi.fn().mockImplementation(() => ({ send: lambdaSendMock })),
  InvokeCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
}));

const { handler } = await import('./actions-execute.js');

function buildEvent(body: unknown): any {
  return { headers: {}, rawPath: '/actions/execute', requestContext: { http: { method: 'POST' } }, body: JSON.stringify(body) };
}

beforeEach(() => {
  lambdaSendMock.mockReset();
});

/**
 * Regression test for the RBAC hole: `POST /actions/execute` was gated only by `allowedGroupIds`
 * (the general sign-in gate) and used to accept EVERY entry in `ACTION_CATALOG` — including the 4
 * lifecycle actions that have their own `operatorGroupIds` gate on `POST /actions/lifecycle`, then
 * forwarded them to the SAME `ActionExecutionFunction`. Consequence: any signed-in account (NOT in
 * the operator group) could reboot/start/stop EC2/RDS with a single request to this endpoint.
 *
 * The test must sit at the actual real call site (`handler` of `/actions/execute`) — a standalone
 * test of `isOperatorMember()` would have stayed green through this entire bug because the handler
 * never called that function. The `claims` below deliberately have NO group at all: this represents
 * a validly signed-in user who is excluded from the operator group.
 */
describe('handler (POST /actions/execute) — blocks lifecycle actions', () => {
  const nonOperatorClaims = { sub: 'user-1', preferred_username: 'user@example.com' };

  it.each(['EC2_Reboot', 'RDS_Reboot', 'RDS_Start', 'RDS_Stop'])(
    'throws 400 for %s and does NOT invoke ActionExecutionFunction',
    async (actionType) => {
      await expect(handler(buildEvent({ actionType, resourceId: 'i-abc' }), nonOperatorClaims)).rejects.toMatchObject({
        statusCode: 400,
      });
      expect(lambdaSendMock).not.toHaveBeenCalled();
    },
  );

  it('still allows an action outside the lifecycle group to go through as before', async () => {
    lambdaSendMock.mockResolvedValue({ Payload: Buffer.from(JSON.stringify({ outcome: 'success' })) });

    const res = await handler(buildEvent({ actionType: 'EC2_Start', resourceId: 'i-abc' }), nonOperatorClaims);

    const typedRes = res as { statusCode: number; body: string };
    expect(typedRes.statusCode).toBe(200);
    expect(JSON.parse(typedRes.body)).toEqual({ outcome: 'success' });
    expect(lambdaSendMock).toHaveBeenCalledTimes(1);
  });

  it('throws 400 when actionType is not in ACTION_CATALOG', async () => {
    await expect(handler(buildEvent({ actionType: 'Nonexistent_Action', resourceId: 'i-abc' }), nonOperatorClaims)).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(lambdaSendMock).not.toHaveBeenCalled();
  });
});

/**
 * Regression test for a SEPARATE bypass of the maker-checker approval workflow (`shared/src/approval.ts`):
 * `isApprovalRequiredActionType()` returns true for EITHER an operator-only actionType (already
 * blocked above by `isOperatorOnlyActionType`) OR an IRREVERSIBLE-but-NOT-operator-only actionType
 * (e.g. `ElasticIp_Release`, `Snapshot_And_Delete_EBS_Volume`, `RDS_IncreaseStorage`,
 * `SecurityGroup_Delete`) — this second category has NO `operatorGroupIds` gate of its own, so
 * without an explicit check here, ANY signed-in account could execute it directly via this
 * endpoint, skipping the required second person's sign-off entirely.
 */
describe('handler (POST /actions/execute) — blocks approval-required, non-operator-only actions', () => {
  const nonOperatorClaims = { sub: 'user-1', preferred_username: 'user@example.com' };

  it.each(['ElasticIp_Release', 'Snapshot_And_Delete_EBS_Volume', 'RDS_IncreaseStorage'])(
    'throws 400 for %s (requires approval) and does NOT invoke ActionExecutionFunction',
    async (actionType) => {
      await expect(handler(buildEvent({ actionType, resourceId: 'i-abc' }), nonOperatorClaims)).rejects.toMatchObject({
        statusCode: 400,
      });
      expect(lambdaSendMock).not.toHaveBeenCalled();
    },
  );
});
