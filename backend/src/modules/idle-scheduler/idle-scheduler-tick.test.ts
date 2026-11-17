import { describe, it, expect, vi, beforeEach } from 'vitest';

// Regression test for a BUG found in the wild (2026-09-22, abc-stg-alb): `sumRequestsInWindow`
// used to build the CloudWatch `LoadBalancer` dimension as `app/${albArnSuffix}`, but
// `albArnSuffix` (from `extractAlbArnSuffix`) is ALREADY in the `app/<name>/<id>` form —
// producing `app/app/<name>/<id>`, which matches no real ALB. `GetMetricStatistics` silently
// returned 0 datapoints (no throw, no error log) for that malformed dimension, so
// `decideIdleStop` always saw `requestsInIdleWindow=0` and stopped the instance every cycle after
// the grace period, REGARDLESS of real traffic on the ALB. Confirmed against the real AWS
// account: `abc-stg-alb` had 700+ real requests in the exact 120-minute window idle-scheduler-tick
// queried, yet its own logs recorded "0 requests in 120m" at the moment it stopped the instance.
//
// This test asserts the CloudWatch call this module makes uses the single-`app/` dimension value
// (matching what `PutMetricAlarm` in idle-scheduler-mutate-handler.ts and the live AWS ARN format
// both expect), and that a group with real traffic is correctly skipped rather than stopped.

process.env.AWS_REGION = 'ap-southeast-1';

const elbSendMock = vi.fn();
const ec2SendMock = vi.fn();
const rdsSendMock = vi.fn();
const cwSendMock = vi.fn();

vi.mock('@aws-sdk/client-elastic-load-balancing-v2', () => ({
  ElasticLoadBalancingV2Client: vi.fn().mockImplementation(() => ({ send: elbSendMock })),
  DescribeLoadBalancersCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'DescribeLoadBalancers', input })),
  DescribeTagsCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'DescribeTags', input })),
  DescribeTargetGroupsCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'DescribeTargetGroups', input })),
}));

vi.mock('@aws-sdk/client-ec2', () => ({
  EC2Client: vi.fn().mockImplementation(() => ({ send: ec2SendMock })),
  DescribeInstancesCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'DescribeInstances', input })),
  StopInstancesCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'StopInstances', input })),
}));

vi.mock('@aws-sdk/client-rds', () => ({
  RDSClient: vi.fn().mockImplementation(() => ({ send: rdsSendMock })),
  DescribeDBInstancesCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'DescribeDBInstances', input })),
  StopDBInstanceCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'StopDBInstance', input })),
}));

vi.mock('@aws-sdk/client-cloudwatch', () => ({
  CloudWatchClient: vi.fn().mockImplementation(() => ({ send: cwSendMock })),
  GetMetricStatisticsCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'GetMetricStatistics', input })),
}));

vi.mock('../alerting/discordWebhook.js', () => ({ postDiscordEmbeds: vi.fn() }));

const { handler } = await import('./idle-scheduler-tick.js');

const ALB_ARN = 'arn:aws:elasticloadbalancing:ap-southeast-1:123456789012:loadbalancer/app/abc-stg-alb/1111222233334444';
const TG_ARN = 'arn:aws:elasticloadbalancing:ap-southeast-1:123456789012:targetgroup/partners-stg-tg/c2a73941efe06e18';

beforeEach(() => {
  elbSendMock.mockReset();
  ec2SendMock.mockReset();
  rdsSendMock.mockReset();
  cwSendMock.mockReset();

  elbSendMock.mockImplementation(async (command: { __type?: string }) => {
    if (command.__type === 'DescribeLoadBalancers') {
      return { LoadBalancers: [{ LoadBalancerArn: ALB_ARN, LoadBalancerName: 'abc-stg-alb' }] };
    }
    if (command.__type === 'DescribeTags') {
      return {
        TagDescriptions: [
          {
            ResourceArn: ALB_ARN,
            Tags: [
              { Key: 'IdleScheduler:Managed', Value: 'true' },
              { Key: 'IdleScheduler:Ec2InstanceId', Value: 'i-0a1b2c3d4e5f60005' },
              { Key: 'IdleScheduler:RdsInstanceId', Value: 'abc-stg-rds-postgres' },
              { Key: 'IdleScheduler:IdleMinutes', Value: '120' },
            ],
          },
        ],
      };
    }
    if (command.__type === 'DescribeTargetGroups') {
      return { TargetGroups: [{ TargetGroupArn: TG_ARN }] };
    }
    throw new Error(`unexpected ELB command in test mock: ${command.__type}`);
  });

  ec2SendMock.mockResolvedValue({
    Reservations: [
      {
        Instances: [
          {
            InstanceId: 'i-0a1b2c3d4e5f60005',
            State: { Name: 'running' },
            LaunchTime: new Date(Date.now() - 60 * 60_000), // launched 60 min ago — well past the 10-min grace period
            Tags: [],
          },
        ],
      },
    ],
  });
});

describe('idle-scheduler-tick — CloudWatch dimension regression', () => {
  it('queries RequestCount with the single-"app/" LoadBalancer dimension (never double-prefixed)', async () => {
    cwSendMock.mockResolvedValue({ Datapoints: [{ Sum: 42 }] });

    await handler();

    expect(cwSendMock).toHaveBeenCalledTimes(1);
    const call = cwSendMock.mock.calls[0][0] as { input: any };
    const lbDimension = call.input.Dimensions.find((d: { Name: string }) => d.Name === 'LoadBalancer');
    expect(lbDimension.Value).toBe('app/abc-stg-alb/1111222233334444');
    expect(lbDimension.Value).not.toContain('app/app/');
  });

  it('does NOT stop the instance when CloudWatch reports real traffic in the idle window', async () => {
    cwSendMock.mockResolvedValue({ Datapoints: [{ Sum: 700 }] });

    const result = await handler();

    expect(result.stopped).toBe(0);
    expect(ec2SendMock).not.toHaveBeenCalledWith(expect.objectContaining({ __type: 'StopInstances' }));
  });

  it('stops the instance when CloudWatch genuinely reports zero requests in the idle window', async () => {
    cwSendMock.mockResolvedValue({ Datapoints: [{ Sum: 0 }] });
    rdsSendMock.mockResolvedValue({ DBInstances: [{ DBInstanceStatus: 'available' }] });

    const result = await handler();

    expect(result.stopped).toBe(1);
    expect(ec2SendMock).toHaveBeenCalledWith(expect.objectContaining({ __type: 'StopInstances' }));
  });

  it('handles an EC2-only group (no rds-instance-id tag) without flagging it misconfigured, and never touches RDS', async () => {
    elbSendMock.mockImplementation(async (command: { __type?: string }) => {
      if (command.__type === 'DescribeLoadBalancers') {
        return { LoadBalancers: [{ LoadBalancerArn: ALB_ARN, LoadBalancerName: 'abc-stg-alb' }] };
      }
      if (command.__type === 'DescribeTags') {
        return {
          TagDescriptions: [
            {
              ResourceArn: ALB_ARN,
              Tags: [
                { Key: 'IdleScheduler:Managed', Value: 'true' },
                { Key: 'IdleScheduler:Ec2InstanceId', Value: 'i-0a1b2c3d4e5f60005' },
                { Key: 'IdleScheduler:IdleMinutes', Value: '120' },
              ],
            },
          ],
        };
      }
      if (command.__type === 'DescribeTargetGroups') {
        return { TargetGroups: [{ TargetGroupArn: TG_ARN }] };
      }
      throw new Error(`unexpected ELB command in test mock: ${command.__type}`);
    });
    cwSendMock.mockResolvedValue({ Datapoints: [{ Sum: 0 }] });

    const result = await handler();

    expect(result.misconfigured).toEqual([]);
    expect(result.stopped).toBe(1);
    expect(ec2SendMock).toHaveBeenCalledWith(expect.objectContaining({ __type: 'StopInstances' }));
    expect(rdsSendMock).not.toHaveBeenCalled();
  });
});
