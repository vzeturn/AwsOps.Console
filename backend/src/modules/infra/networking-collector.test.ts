import { describe, it, expect, vi, beforeEach } from 'vitest';

// Task 6.6: unit test for networking-collector.ts
// The collector reads the region directly from process.env.AWS_REGION (the Lambda runtime always
// sets this variable itself) — set it before importing the module; no more mocking config.ts
// (the collector doesn't import config.ts).
process.env.AWS_REGION = 'ap-southeast-1';

const ec2SendMock = vi.fn();
const cloudwatchSendMock = vi.fn();
const elbSendMock = vi.fn();

vi.mock('@aws-sdk/client-ec2', () => ({
  EC2Client: vi.fn().mockImplementation(() => ({ send: ec2SendMock })),
  DescribeNatGatewaysCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
}));

vi.mock('@aws-sdk/client-cloudwatch', () => ({
  CloudWatchClient: vi.fn().mockImplementation(() => ({ send: cloudwatchSendMock })),
  GetMetricDataCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
}));

vi.mock('@aws-sdk/client-elastic-load-balancing-v2', () => ({
  ElasticLoadBalancingV2Client: vi.fn().mockImplementation(() => ({ send: elbSendMock })),
  DescribeLoadBalancersCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
  DescribeTargetGroupsCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
  DescribeTargetHealthCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
}));

// Import after the mocks are declared (vi.mock is hoisted to the top by vitest).
const { collectNetworkingData } = await import('./networking-collector.js');

beforeEach(() => {
  ec2SendMock.mockReset();
  cloudwatchSendMock.mockReset();
  elbSendMock.mockReset();
});

describe('collectNetworkingData', () => {
  it('returns avgBytesProcessedPerDay matching the mocked low-throughput value from CloudWatch for a NAT Gateway', async () => {
    ec2SendMock.mockResolvedValue({
      NatGateways: [{ NatGatewayId: 'nat-lowtraffic1' }],
    });
    // Total BytesOutToDestination over the survey period (14 days) = 1_400 bytes => average 100/day.
    cloudwatchSendMock.mockResolvedValue({
      MetricDataResults: [{ Id: 'nat0', Values: new Array(14).fill(100) }],
    });
    elbSendMock.mockResolvedValue({ LoadBalancers: [] });

    const result = await collectNetworkingData();

    expect(result.natGateways).toHaveLength(1);
    expect(result.natGateways[0]).toMatchObject({
      natGatewayId: 'nat-lowtraffic1',
      region: 'ap-southeast-1',
      avgBytesProcessedPerDay: 100,
    });
  });

  it('returns unhealthyTargets === totalTargets when the ALB has all targets unhealthy', async () => {
    ec2SendMock.mockResolvedValue({ NatGateways: [] });
    elbSendMock.mockImplementation(async (command: { input?: Record<string, unknown> }) => {
      const input = command.input ?? {};
      if ('LoadBalancerArn' in input === false && 'TargetGroupArn' in input === false) {
        // DescribeLoadBalancersCommand
        return {
          LoadBalancers: [
            { LoadBalancerArn: 'arn:alb-1', LoadBalancerName: 'alb-all-unhealthy' },
          ],
        };
      }
      if ('LoadBalancerArn' in input) {
        // DescribeTargetGroupsCommand
        return { TargetGroups: [{ TargetGroupArn: 'arn:tg-1' }] };
      }
      // DescribeTargetHealthCommand
      return {
        TargetHealthDescriptions: [
          { TargetHealth: { State: 'unhealthy' } },
          { TargetHealth: { State: 'unhealthy' } },
        ],
      };
    });

    const result = await collectNetworkingData();

    expect(result.albs).toHaveLength(1);
    expect(result.albs[0]).toMatchObject({
      name: 'alb-all-unhealthy',
      region: 'ap-southeast-1',
      totalTargets: 2,
      unhealthyTargets: 2,
    });
  });

  it('merges ALBs across multiple pages when DescribeLoadBalancers returns a NextMarker', async () => {
    ec2SendMock.mockResolvedValue({ NatGateways: [] });
    let describeLoadBalancersCalls = 0;
    elbSendMock.mockImplementation(async (command: { input?: Record<string, unknown> }) => {
      const input = command.input ?? {};
      if ('LoadBalancerArn' in input) return { TargetGroups: [] };
      if ('TargetGroupArn' in input) return { TargetHealthDescriptions: [] };
      // DescribeLoadBalancersCommand
      describeLoadBalancersCalls += 1;
      if (describeLoadBalancersCalls === 1) {
        return {
          LoadBalancers: [{ LoadBalancerArn: 'arn:alb-page1', LoadBalancerName: 'alb-page1' }],
          NextMarker: 'marker-page-2',
        };
      }
      return { LoadBalancers: [{ LoadBalancerArn: 'arn:alb-page2', LoadBalancerName: 'alb-page2' }] };
    });

    const result = await collectNetworkingData();

    expect(result.albs.map((a) => a.name)).toEqual(['alb-page1', 'alb-page2']);
    expect(describeLoadBalancersCalls).toBe(2);
  });

  it('merges NAT gateways across multiple pages when DescribeNatGateways returns a NextToken', async () => {
    ec2SendMock
      .mockResolvedValueOnce({ NatGateways: [{ NatGatewayId: 'nat-page1' }], NextToken: 'token-page-2' })
      .mockResolvedValueOnce({ NatGateways: [{ NatGatewayId: 'nat-page2' }] });
    cloudwatchSendMock.mockResolvedValue({ MetricDataResults: [] });
    elbSendMock.mockResolvedValue({ LoadBalancers: [] });

    const result = await collectNetworkingData();

    expect(result.natGateways.map((n) => n.natGatewayId)).toEqual(['nat-page1', 'nat-page2']);
    expect(ec2SendMock).toHaveBeenCalledTimes(2);
  });

  it('NAT source failing (DescribeNatGateways throws) does not break the ALB source — ALB still returns correctly', async () => {
    ec2SendMock.mockRejectedValue(new Error('AccessDenied'));
    elbSendMock.mockImplementation(async (command: { input?: Record<string, unknown> }) => {
      const input = command.input ?? {};
      if ('LoadBalancerArn' in input === false && 'TargetGroupArn' in input === false) {
        return {
          LoadBalancers: [{ LoadBalancerArn: 'arn:alb-2', LoadBalancerName: 'alb-healthy' }],
        };
      }
      if ('LoadBalancerArn' in input) {
        return { TargetGroups: [{ TargetGroupArn: 'arn:tg-2' }] };
      }
      return {
        TargetHealthDescriptions: [{ TargetHealth: { State: 'healthy' } }],
      };
    });

    const result = await collectNetworkingData();

    expect(result.natGateways).toEqual([]);
    expect(cloudwatchSendMock).not.toHaveBeenCalled();
    expect(result.albs).toHaveLength(1);
    expect(result.albs[0]).toMatchObject({
      name: 'alb-healthy',
      totalTargets: 1,
      unhealthyTargets: 0,
    });
  });
});
