import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../config.js', () => ({
  config: {
    allowedOrigins: [],
    entraTenantId: 'test-tenant',
    entraClientId: 'test-client',
    allowedGroupIds: [],
    operatorGroupIds: ['operator-group-1'],
    awsRegion: 'ap-southeast-1',
  },
  corsHeaders: () => ({}),
}));

const buildActionPreviewMock = vi.fn();
const buildActionPreviewDirectMock = vi.fn();
vi.mock('./preview-service.js', () => ({
  buildActionPreview: buildActionPreviewMock,
  buildActionPreviewDirect: buildActionPreviewDirectMock,
}));

const { handler } = await import('./actions-preview.js');

function buildEvent(queryStringParameters: Record<string, string>): any {
  return {
    headers: {},
    rawPath: '/actions/preview',
    requestContext: { http: { method: 'GET' } },
    queryStringParameters,
  };
}

const OPERATOR_CLAIMS = { sub: 'op-1', preferred_username: 'op@example.com', groups: ['operator-group-1'] };
const NON_OPERATOR_CLAIMS = { sub: 'user-1', preferred_username: 'user@example.com' };

beforeEach(() => {
  buildActionPreviewMock.mockReset();
  buildActionPreviewDirectMock.mockReset();
});

/**
 * Regression test for I4: `GET /actions/preview` used to go through only the general sign-in gate,
 * so a user NOT in the operator group could still open a full preview (with all parameters) of the
 * 4 lifecycle actions — even though that same action is blocked on `POST /actions/lifecycle`.
 */
describe('handler (GET /actions/preview) — operator gate for lifecycle actions', () => {
  // The 2 Security Group actions are also covered by `isOperatorOnlyActionType()` — their preview
  // reveals the Security Group's name/VPC and confirms which rule currently exists, so it must be
  // gated the same as the mutating call.
  it.each([
    'EC2_Reboot',
    'RDS_Reboot',
    'RDS_Start',
    'RDS_Stop',
    'SecurityGroup_AuthorizeIngress',
    'SecurityGroup_RevokeIngress',
  ])(
    'throws 403 for %s when claims are not in the operator group, and does NOT build a preview',
    async (actionType) => {
      await expect(
        handler(buildEvent({ actionType, resourceId: 'i-abc' }), NON_OPERATOR_CLAIMS),
      ).rejects.toMatchObject({ statusCode: 403 });
      expect(buildActionPreviewDirectMock).not.toHaveBeenCalled();
    },
  );

  it('allows an operator to view the preview of a lifecycle action', async () => {
    buildActionPreviewDirectMock.mockResolvedValue({ actionType: 'RDS_Reboot' });

    const res = (await handler(
      buildEvent({ actionType: 'RDS_Reboot', resourceId: 'db-1' }),
      OPERATOR_CLAIMS,
    )) as { statusCode: number; body: string };

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ actionType: 'RDS_Reboot' });
  });

  it('does not block a regular action for a regular user', async () => {
    buildActionPreviewDirectMock.mockResolvedValue({ actionType: 'EC2_Start' });

    const res = (await handler(
      buildEvent({ actionType: 'EC2_Start', resourceId: 'i-abc' }),
      NON_OPERATOR_CLAIMS,
    )) as { statusCode: number; body: string };

    expect(res.statusCode).toBe(200);
    // The 3rd argument is the remaining query params after stripping recommendationId/actionType/
    // resourceId — empty here since EC2_Start takes no extra parameters (only Security Group
    // ingress uses them).
    expect(buildActionPreviewDirectMock).toHaveBeenCalledWith('EC2_Start', 'i-abc', {});
  });

  it('forwards the query params describing the rule down to the preview for a Security Group action', async () => {
    buildActionPreviewDirectMock.mockResolvedValue({ actionType: 'SecurityGroup_AuthorizeIngress' });

    await handler(
      buildEvent({
        actionType: 'SecurityGroup_AuthorizeIngress',
        resourceId: 'sg-0123abcd',
        protocol: 'tcp',
        fromPort: '22',
        toPort: '22',
        cidrIp: '0.0.0.0/0',
      }),
      OPERATOR_CLAIMS,
    );

    // Without this step, the preview wouldn't know which rule is being viewed — losing the security
    // warning entirely.
    expect(buildActionPreviewDirectMock).toHaveBeenCalledWith('SecurityGroup_AuthorizeIngress', 'sg-0123abcd', {
      protocol: 'tcp',
      fromPort: '22',
      toPort: '22',
      cidrIp: '0.0.0.0/0',
    });
  });

  it('the recommendationId branch is also gated when the recommendation leads to a lifecycle action', async () => {
    buildActionPreviewMock.mockResolvedValue({ actionType: 'EC2_Reboot' });

    await expect(
      handler(buildEvent({ recommendationId: 'rec-1' }), NON_OPERATOR_CLAIMS),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('throws 400 when a required parameter is missing', async () => {
    await expect(handler(buildEvent({}), OPERATOR_CLAIMS)).rejects.toMatchObject({ statusCode: 400 });
  });
});
