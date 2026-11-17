import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../config.js', () => ({
  config: { awsRegion: 'ap-southeast-1' },
  corsHeaders: () => ({}),
}));

const ec2SendMock = vi.fn();
vi.mock('@aws-sdk/client-ec2', () => ({
  EC2Client: vi.fn().mockImplementation(() => ({ send: ec2SendMock })),
  DescribeSecurityGroupsCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'Describe', input })),
  AuthorizeSecurityGroupIngressCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'Authorize', input })),
  RevokeSecurityGroupIngressCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'Revoke', input })),
}));

const { executeSecurityGroupIngress } = await import('./security-group-action-service.js');

const RULE = { protocol: 'tcp', fromPort: 22, toPort: 22, cidrIp: '10.0.0.0/16' };
const EXISTING_PERMISSION = { IpProtocol: 'tcp', FromPort: 22, ToPort: 22, IpRanges: [{ CidrIp: '10.0.0.0/16' }] };

/** Mocks describe to return 1 SG with the given permission list; every mutate command returns empty. */
function mockGroup(permissions: unknown[]) {
  ec2SendMock.mockImplementation(async (command: { __type: string }) => {
    if (command.__type === 'Describe') {
      return { SecurityGroups: [{ GroupId: 'sg-0123abcd', IpPermissions: permissions }] };
    }
    return {};
  });
}

function awsError(name: string): Error {
  const err = new Error(name);
  err.name = name;
  return err;
}

/** The mutate command sent (if any) — used to assert "exactly ONE command, with the right payload". */
function mutateCommands() {
  return ec2SendMock.mock.calls.map((c) => c[0]).filter((c: { __type: string }) => c.__type !== 'Describe');
}

beforeEach(() => {
  ec2SendMock.mockReset();
});

describe('executeSecurityGroupIngress', () => {
  it('adds a rule successfully and sends EXACTLY one AuthorizeSecurityGroupIngress', async () => {
    mockGroup([]);

    const result = await executeSecurityGroupIngress('SecurityGroup_AuthorizeIngress', 'sg-0123abcd', {
      ...RULE,
      description: 'VPN office',
    });

    expect(result).toEqual({ outcome: 'success', appliedSecurityGroupRule: 'OPEN tcp 22 (SSH) for 10.0.0.0/16' });
    expect(mutateCommands()).toEqual([
      {
        __type: 'Authorize',
        input: {
          GroupId: 'sg-0123abcd',
          IpPermissions: [
            {
              IpProtocol: 'tcp',
              FromPort: 22,
              ToPort: 22,
              IpRanges: [{ CidrIp: '10.0.0.0/16', Description: 'VPN office' }],
            },
          ],
        },
      },
    ]);
  });

  it('removes a rule successfully when the rule exists', async () => {
    mockGroup([EXISTING_PERMISSION]);

    const result = await executeSecurityGroupIngress('SecurityGroup_RevokeIngress', 'sg-0123abcd', RULE);

    expect(result).toEqual({ outcome: 'success', appliedSecurityGroupRule: 'CLOSE tcp 22 (SSH) for 10.0.0.0/16' });
    expect(mutateCommands()).toHaveLength(1);
    expect(mutateCommands()[0].__type).toBe('Revoke');
  });

  it('validates AGAIN at the execution layer — bad params are rejected, AWS is NOT called', async () => {
    const result = await executeSecurityGroupIngress('SecurityGroup_AuthorizeIngress', 'sg-0123abcd', {
      ...RULE,
      cidrIp: '10.0.0.1/16',
    });

    expect(result.outcome).toBe('rejected');
    expect(ec2SendMock).not.toHaveBeenCalled();
  });

  it('rejects (no mutate) when the rule already exists on add', async () => {
    mockGroup([EXISTING_PERMISSION]);

    const result = await executeSecurityGroupIngress('SecurityGroup_AuthorizeIngress', 'sg-0123abcd', RULE);

    expect(result.outcome).toBe('rejected');
    expect(mutateCommands()).toHaveLength(0);
  });

  it('rejects (no mutate) when the rule does not exist on remove', async () => {
    mockGroup([]);

    const result = await executeSecurityGroupIngress('SecurityGroup_RevokeIngress', 'sg-0123abcd', RULE);

    expect(result.outcome).toBe('rejected');
    expect(mutateCommands()).toHaveLength(0);
  });

  it('returns rejected when the Security Group is not found (both when AWS throws and when it returns empty)', async () => {
    ec2SendMock.mockRejectedValueOnce(awsError('InvalidGroup.NotFound'));
    expect((await executeSecurityGroupIngress('SecurityGroup_AuthorizeIngress', 'sg-0123abcd', RULE)).outcome).toBe(
      'rejected',
    );

    ec2SendMock.mockResolvedValueOnce({ SecurityGroups: [] });
    expect((await executeSecurityGroupIngress('SecurityGroup_AuthorizeIngress', 'sg-0123abcd', RULE)).outcome).toBe(
      'rejected',
    );
  });

  it('maps RACE errors (Duplicate/NotFound) to rejected — not a system incident', async () => {
    ec2SendMock.mockImplementation(async (command: { __type: string }) => {
      if (command.__type === 'Describe') return { SecurityGroups: [{ GroupId: 'sg-0123abcd', IpPermissions: [] }] };
      throw awsError('InvalidPermission.Duplicate');
    });

    const result = await executeSecurityGroupIngress('SecurityGroup_AuthorizeIngress', 'sg-0123abcd', RULE);

    expect(result.outcome).toBe('rejected');
    expect(result.reason).toContain('already exists');
  });

  it('returns failure for a genuine AWS error (e.g. missing permission)', async () => {
    ec2SendMock.mockImplementation(async (command: { __type: string }) => {
      if (command.__type === 'Describe') return { SecurityGroups: [{ GroupId: 'sg-0123abcd', IpPermissions: [] }] };
      throw awsError('UnauthorizedOperation');
    });

    const result = await executeSecurityGroupIngress('SecurityGroup_AuthorizeIngress', 'sg-0123abcd', RULE);

    expect(result.outcome).toBe('failure');
    expect(result.reason).toContain('AuthorizeSecurityGroupIngress');
  });

  it('returns failure when the SG state cannot be read (a describe error other than NotFound)', async () => {
    ec2SendMock.mockRejectedValue(awsError('RequestLimitExceeded'));

    const result = await executeSecurityGroupIngress('SecurityGroup_RevokeIngress', 'sg-0123abcd', RULE);

    expect(result.outcome).toBe('failure');
    expect(mutateCommands()).toHaveLength(0);
  });
});
