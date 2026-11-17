import { describe, it, expect, vi, beforeEach } from 'vitest';

// Preview for the 2 Security Group actions (spec 2026-08-25). Only @aws-sdk/client-ec2 is mocked —
// `preview-service.ts` imports several other SDK clients at module scope, but their constructors
// don't touch the network so they need no mock; only `config.js` is required (reading real env would throw).
vi.mock('../../config.js', () => ({
  config: { awsRegion: 'ap-southeast-1' },
  corsHeaders: () => ({}),
}));

const ec2SendMock = vi.fn();
vi.mock('@aws-sdk/client-ec2', () => ({
  EC2Client: vi.fn().mockImplementation(() => ({ send: ec2SendMock })),
  DescribeSecurityGroupsCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
  DescribeVolumesCommand: vi.fn(),
  DescribeAddressesCommand: vi.fn(),
  DescribeInstancesCommand: vi.fn(),
}));

const { buildActionPreviewDirect } = await import('./preview-service.js');

const GROUP = { GroupId: 'sg-0123abcd', GroupName: 'web-sg', VpcId: 'vpc-1', IpPermissions: [] as unknown[] };
const OPEN_SSH = { protocol: 'tcp', fromPort: '22', toPort: '22', cidrIp: '0.0.0.0/0' };

function mockGroup(permissions: unknown[] = []) {
  ec2SendMock.mockResolvedValue({ SecurityGroups: [{ ...GROUP, IpPermissions: permissions }] });
}

beforeEach(() => {
  ec2SendMock.mockReset();
});

describe('buildActionPreviewDirect — Security Group ingress', () => {
  it('returns a preview with a CRITICAL WARNING when opening a sensitive port to the entire Internet', async () => {
    mockGroup();

    const preview = await buildActionPreviewDirect('SecurityGroup_AuthorizeIngress', 'sg-0123abcd', OPEN_SSH);

    expect(preview.awsApiCall).toBe('ec2:AuthorizeSecurityGroupIngress');
    expect(preview.resource).toEqual({
      id: 'sg-0123abcd',
      arn: 'arn:aws:ec2:ap-southeast-1:123456789012:security-group/sg-0123abcd',
      region: 'ap-southeast-1',
    });
    expect(preview.params).toMatchObject({ securityGroupName: 'web-sg', vpcId: 'vpc-1', summary: 'OPEN tcp 22 (SSH) for 0.0.0.0/0' });
    expect(preview.securityImpactWarning).toContain('CRITICAL');
  });

  it('does NOT attach securityImpactWarning for a narrow rule (field absent, not undefined)', async () => {
    mockGroup();

    const preview = await buildActionPreviewDirect('SecurityGroup_AuthorizeIngress', 'sg-0123abcd', {
      ...OPEN_SSH,
      cidrIp: '10.0.0.0/16',
    });

    expect('securityImpactWarning' in preview).toBe(false);
  });

  it('throws 400 when the rule already exists on add (blocks InvalidPermission.Duplicate right at preview)', async () => {
    mockGroup([{ IpProtocol: 'tcp', FromPort: 22, ToPort: 22, IpRanges: [{ CidrIp: '0.0.0.0/0' }] }]);

    await expect(
      buildActionPreviewDirect('SecurityGroup_AuthorizeIngress', 'sg-0123abcd', OPEN_SSH),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('throws 400 when the rule to remove does not exist (blocks InvalidPermission.NotFound)', async () => {
    mockGroup();

    await expect(
      buildActionPreviewDirect('SecurityGroup_RevokeIngress', 'sg-0123abcd', OPEN_SSH),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('throws 400 when rule parameters are invalid — AWS is NOT called', async () => {
    await expect(
      buildActionPreviewDirect('SecurityGroup_AuthorizeIngress', 'sg-0123abcd', { ...OPEN_SSH, cidrIp: '10.0.0.1/16' }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(ec2SendMock).not.toHaveBeenCalled();
  });

  it('throws 404 when the Security Group is not found', async () => {
    const err = new Error('InvalidGroup.NotFound');
    err.name = 'InvalidGroup.NotFound';
    ec2SendMock.mockRejectedValue(err);

    await expect(
      buildActionPreviewDirect('SecurityGroup_AuthorizeIngress', 'sg-0123abcd', OPEN_SSH),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
