import { describe, it, expect, vi, beforeEach } from 'vitest';

// infra-service.ts must NOT import config.ts (a module singleton that throws when required env
// is missing) because it's also bundled into InfraCollectorFunction — that Lambda only has 2
// environment variables. It reads `process.env.AWS_REGION` via `lib/awsRegion.ts`, same as
// compliance-service.test.ts.
process.env.AWS_REGION = 'ap-southeast-1';

const ec2SendMock = vi.fn();

vi.mock('@aws-sdk/client-ec2', () => ({
  EC2Client: vi.fn().mockImplementation(() => ({ send: ec2SendMock })),
  DescribeInstancesCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
}));

const rdsSendMock = vi.fn();

vi.mock('@aws-sdk/client-rds', () => ({
  RDSClient: vi.fn().mockImplementation(() => ({ send: rdsSendMock })),
  DescribeDBInstancesCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
}));

const elbSendMock = vi.fn();

vi.mock('@aws-sdk/client-elastic-load-balancing-v2', () => ({
  ElasticLoadBalancingV2Client: vi.fn().mockImplementation(() => ({ send: elbSendMock })),
  DescribeLoadBalancersCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'DescribeLoadBalancers', input })),
  DescribeTargetGroupsCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'DescribeTargetGroups', input })),
  DescribeTargetHealthCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'DescribeTargetHealth', input })),
  DescribeTagsCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'DescribeTags', input })),
}));

const { extractAlbArnSuffix, loadAlb, getInfraData } = await import('./infra-service.js');

beforeEach(() => {
  ec2SendMock.mockReset();
  rdsSendMock.mockReset();
  elbSendMock.mockReset();
});

// Regression test for a BUG found in the wild: `loadAlb()` used to pass the bare
// `LoadBalancerName` as the `LoadBalancer` dimension value sent to CloudWatch — but CloudWatch
// (namespace AWS/ApplicationELB) ONLY accepts the "app/<name>/<id>" form (the ARN tail), which
// meant EVERY GetMetricData/DescribeAlarms call for the ALB silently returned 0 datapoints/no
// matched alarm — no throw, no clear error log. Confirmed against the real AWS_Account
// (abc-prod-alb): the real ARN is
// arn:aws:elasticloadbalancing:ap-southeast-1:123456789012:loadbalancer/app/abc-prod-alb/0123456789abcdef.
describe('extractAlbArnSuffix — ALB CloudWatch dimension bug fix', () => {
  it('extracts the correct "app/<name>/<id>" from a real ALB ARN (abc-prod-alb)', () => {
    const arn = 'arn:aws:elasticloadbalancing:ap-southeast-1:123456789012:loadbalancer/app/abc-prod-alb/0123456789abcdef';
    expect(extractAlbArnSuffix(arn)).toBe('app/abc-prod-alb/0123456789abcdef');
  });

  it('returns undefined when the ARN has no ":loadbalancer/" marker (does not throw)', () => {
    expect(extractAlbArnSuffix('not-an-arn')).toBeUndefined();
  });

  it('returns undefined when the ARN is undefined (LoadBalancerArn missing from the AWS response)', () => {
    expect(extractAlbArnSuffix(undefined)).toBeUndefined();
  });

  it('never returns the bare LoadBalancerName itself (asserts the fix, not the old behavior)', () => {
    const arn = 'arn:aws:elasticloadbalancing:ap-southeast-1:123456789012:loadbalancer/app/abc-prod-alb/0123456789abcdef';
    expect(extractAlbArnSuffix(arn)).not.toBe('abc-prod-alb');
  });
});

describe('loadEc2', () => {
  it('merges EC2 results across multiple pages when DescribeInstances returns NextToken', async () => {
    ec2SendMock
      .mockResolvedValueOnce({
        Reservations: [
          { Instances: [{ InstanceId: 'i-page1', InstanceType: 't3.micro', State: { Name: 'running' }, Tags: [] }] },
        ],
        NextToken: 'token-page-2',
      })
      .mockResolvedValueOnce({
        Reservations: [
          { Instances: [{ InstanceId: 'i-page2', InstanceType: 't3.small', State: { Name: 'running' }, Tags: [] }] },
        ],
      });

    rdsSendMock.mockResolvedValue({ DBInstances: [] });
    elbSendMock.mockResolvedValue({ LoadBalancers: [] });

    const result = await getInfraData();

    expect(result.ec2.map((i) => i.instanceId)).toEqual(['i-page1', 'i-page2']);
    expect(ec2SendMock).toHaveBeenCalledTimes(2);
  });

  it('asOf matches generatedAt', async () => {
    ec2SendMock.mockResolvedValue({ Reservations: [] });
    rdsSendMock.mockResolvedValue({ DBInstances: [] });
    elbSendMock.mockResolvedValue({ LoadBalancers: [] });

    const result = await getInfraData();
    expect(result.asOf).toBe(result.generatedAt);
  });
});

// New feature: Monitoring_Page shows "which target group has a problem" when the ALB is
// unhealthy, instead of just an ALB-wide aggregate — requires loadAlb() to return a breakdown
// per target group.
describe('loadAlb — target group breakdown', () => {
  it('returns the correct breakdown per target group, correctly summed into the aggregate unhealthyTargets/totalTargets', async () => {
    elbSendMock.mockImplementation(async (command: { __type?: string; input?: any }) => {
      if (command.__type === 'DescribeLoadBalancers') {
        return {
          LoadBalancers: [
            {
              LoadBalancerName: 'abc-prod-alb',
              LoadBalancerArn: 'arn:aws:elasticloadbalancing:ap-southeast-1:123456789012:loadbalancer/app/abc-prod-alb/abc123',
              State: { Code: 'active' },
            },
          ],
        };
      }
      if (command.__type === 'DescribeTargetGroups') {
        return {
          TargetGroups: [
            { TargetGroupName: 'abc-prod-api-tg', TargetGroupArn: 'arn:tg-api' },
            { TargetGroupName: 'abc-prod-adminsite-tg', TargetGroupArn: 'arn:tg-adminsite' },
          ],
        };
      }
      if (command.__type === 'DescribeTargetHealth') {
        if (command.input.TargetGroupArn === 'arn:tg-api') {
          return {
            TargetHealthDescriptions: [
              { TargetHealth: { State: 'healthy' } },
              { TargetHealth: { State: 'unhealthy' } },
            ],
          };
        }
        if (command.input.TargetGroupArn === 'arn:tg-adminsite') {
          return { TargetHealthDescriptions: [{ TargetHealth: { State: 'healthy' } }] };
        }
      }
      if (command.__type === 'DescribeTags') {
        return { TagDescriptions: [{ Tags: [] }] };
      }
      throw new Error('unexpected command in test mock');
    });

    const result = await loadAlb();

    expect(result).toHaveLength(1);
    const alb = result[0];
    expect(alb.unhealthyTargets).toBe(1);
    expect(alb.totalTargets).toBe(3);
    expect(alb.targetGroups).toEqual([
      { targetGroupName: 'abc-prod-api-tg', unhealthyTargets: 1, totalTargets: 2 },
      { targetGroupName: 'abc-prod-adminsite-tg', unhealthyTargets: 0, totalTargets: 1 },
    ]);
  });

  it('returns an empty targetGroups when the ALB has no target groups at all', async () => {
    elbSendMock.mockImplementation(async (command: { __type?: string }) => {
      if (command.__type === 'DescribeLoadBalancers') {
        return {
          LoadBalancers: [
            {
              LoadBalancerName: 'empty-alb',
              LoadBalancerArn: 'arn:aws:elasticloadbalancing:ap-southeast-1:123456789012:loadbalancer/app/empty-alb/xyz',
              State: { Code: 'active' },
            },
          ],
        };
      }
      if (command.__type === 'DescribeTargetGroups') return { TargetGroups: [] };
      if (command.__type === 'DescribeTags') return { TagDescriptions: [{ Tags: [] }] };
      throw new Error('unexpected command in test mock');
    });

    const result = await loadAlb();

    expect(result[0].targetGroups).toEqual([]);
  });
});
