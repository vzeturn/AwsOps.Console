import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../config.js', () => ({
  config: { awsRegion: 'ap-southeast-1' },
  corsHeaders: () => ({}),
}));

const ec2SendMock = vi.fn();
vi.mock('@aws-sdk/client-ec2', () => ({
  EC2Client: vi.fn().mockImplementation(() => ({ send: ec2SendMock })),
  DescribeSecurityGroupsCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'DescribeSecurityGroups', input })),
}));

const { listSecurityGroups } = await import('./security-group-service.js');

beforeEach(() => {
  ec2SendMock.mockReset();
});

describe('listSecurityGroups', () => {
  it('flattens each source into one row and marks removable only for IPv4 CIDR + operable protocol', async () => {
    ec2SendMock.mockResolvedValue({
      SecurityGroups: [
        {
          GroupId: 'sg-0123abcd',
          GroupName: 'web-sg',
          VpcId: 'vpc-1',
          Description: 'web',
          IpPermissions: [
            {
              IpProtocol: 'tcp',
              FromPort: 443,
              ToPort: 443,
              // AWS groups MULTIPLE sources into the same 1 IpPermission — an operator removes one source at a time.
              IpRanges: [{ CidrIp: '10.0.0.0/16', Description: 'VPC' }, { CidrIp: '0.0.0.0/0' }],
              Ipv6Ranges: [{ CidrIpv6: '::/0' }],
              UserIdGroupPairs: [{ GroupId: 'sg-9999zzzz' }],
              PrefixListIds: [{ PrefixListId: 'pl-1234' }],
            },
            // protocol '-1' (all protocols) falls outside the dashboard's operable scope.
            { IpProtocol: '-1', IpRanges: [{ CidrIp: '172.16.0.0/12' }] },
          ],
        },
      ],
    });

    const { groups, truncated } = await listSecurityGroups();

    expect(truncated).toBe(false);
    expect(groups).toHaveLength(1);
    expect(groups[0].ingressRules).toEqual([
      { protocol: 'tcp', fromPort: 443, toPort: 443, cidrIp: '10.0.0.0/16', sourceLabel: '10.0.0.0/16', removable: true, description: 'VPC' },
      { protocol: 'tcp', fromPort: 443, toPort: 443, cidrIp: '0.0.0.0/0', sourceLabel: '0.0.0.0/0', removable: true },
      { protocol: 'tcp', fromPort: 443, toPort: 443, sourceLabel: '::/0', removable: false },
      { protocol: 'tcp', fromPort: 443, toPort: 443, sourceLabel: 'sg-9999zzzz', removable: false },
      { protocol: 'tcp', fromPort: 443, toPort: 443, sourceLabel: 'pl-1234', removable: false },
      { protocol: '-1', fromPort: null, toPort: null, cidrIp: '172.16.0.0/12', sourceLabel: '172.16.0.0/12', removable: false },
    ]);
  });

  it('merges all pages and sorts by name so the order stays stable across reloads', async () => {
    ec2SendMock
      .mockResolvedValueOnce({
        SecurityGroups: [{ GroupId: 'sg-2', GroupName: 'zeta', VpcId: 'vpc-1', Description: '' }],
        NextToken: 'page-2',
      })
      .mockResolvedValueOnce({
        SecurityGroups: [{ GroupId: 'sg-1', GroupName: 'alpha', VpcId: 'vpc-1', Description: '' }],
      });

    const { groups } = await listSecurityGroups();

    expect(ec2SendMock).toHaveBeenCalledTimes(2);
    expect(groups.map((g) => g.groupName)).toEqual(['alpha', 'zeta']);
  });

  it('reports truncated when hitting the 500 SG cap and STOPS paginating', async () => {
    const page = (prefix: string) =>
      Array.from({ length: 400 }, (_, i) => ({
        GroupId: `sg-${prefix}${i}`,
        GroupName: `${prefix}-${i}`,
        VpcId: 'vpc-1',
        Description: '',
      }));
    ec2SendMock
      .mockResolvedValueOnce({ SecurityGroups: page('a'), NextToken: 'page-2' })
      .mockResolvedValueOnce({ SecurityGroups: page('b'), NextToken: 'page-3' });

    const { groups, truncated } = await listSecurityGroups();

    expect(truncated).toBe(true);
    expect(groups).toHaveLength(500);
    // Does not fetch page 3: stop at the cap, don't burn more Lambda time.
    expect(ec2SendMock).toHaveBeenCalledTimes(2);
  });
});
