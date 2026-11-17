import { describe, it, expect, vi, beforeEach } from 'vitest';

// Unit test for inferring AlarmSummary.comparisonOperator from MetricAlarm.ComparisonOperator —
// BUG FIX: the UI used to show the WRONG runbook ("CPU high, needs scale-out") for an "AlarmLow"
// alarm (CPU LOW, target-tracking autoscaling correctly scaling in) because it couldn't
// distinguish the alarm's direction. Follows the same mock pattern as
// alert-service.test.ts/alert-service.ecs.test.ts.
process.env.AWS_REGION = 'ap-southeast-1';
process.env.ASSESSMENT_BUCKET_NAME = 'test-assessment-bucket';

vi.mock('../../config.js', () => ({
  config: {
    allowedOrigins: [],
    entraTenantId: 'test-tenant',
    entraClientId: 'test-client',
    allowedGroupIds: [],
    awsRegion: 'ap-southeast-1',
    costCacheParamName: 'test-cost-cache-param',
    assessmentBucketName: 'test-assessment-bucket',
  },
  corsHeaders: () => ({}),
}));

const cloudwatchSendMock = vi.fn();
const ec2SendMock = vi.fn();
const rdsSendMock = vi.fn();
const elbSendMock = vi.fn();
const s3SendMock = vi.fn();

vi.mock('@aws-sdk/client-cloudwatch', () => ({
  CloudWatchClient: vi.fn().mockImplementation(() => ({ send: cloudwatchSendMock })),
  DescribeAlarmsCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'DescribeAlarms', input })),
  GetMetricDataCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
  ListMetricsCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
}));

vi.mock('@aws-sdk/client-ec2', () => ({
  EC2Client: vi.fn().mockImplementation(() => ({ send: ec2SendMock })),
  DescribeInstancesCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
  DescribeVolumesCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
}));

vi.mock('@aws-sdk/client-rds', () => ({
  RDSClient: vi.fn().mockImplementation(() => ({ send: rdsSendMock })),
  DescribeDBInstancesCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
}));

vi.mock('@aws-sdk/client-elastic-load-balancing-v2', () => ({
  ElasticLoadBalancingV2Client: vi.fn().mockImplementation(() => ({ send: elbSendMock })),
  DescribeLoadBalancersCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
  DescribeTargetGroupsCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
  DescribeTargetHealthCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
}));

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: s3SendMock })),
  GetObjectCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
  PutObjectCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
}));

const { getAlerts } = await import('./alert-service.js');

beforeEach(() => {
  cloudwatchSendMock.mockReset();
});

async function alarmWithOperator(comparisonOperator: string | undefined) {
  cloudwatchSendMock.mockResolvedValue({
    MetricAlarms: [
      {
        AlarmName: 'test-alarm',
        StateValue: 'ALARM',
        Namespace: 'AWS/ECS',
        MetricName: 'CPUUtilization',
        ComparisonOperator: comparisonOperator,
        Dimensions: [
          { Name: 'ClusterName', Value: 'abc-prod-ecs-cluster' },
          { Name: 'ServiceName', Value: 'abc-prod-ecs-service-api' },
        ],
      },
    ],
  });
  const result = await getAlerts();
  return result[0];
}

describe('getAlerts() — comparisonOperator (BUG FIX: distinguish CPU-high vs CPU-low alarms)', () => {
  it.each(['GreaterThanThreshold', 'GreaterThanOrEqualToThreshold', 'GreaterThanUpperThreshold'])(
    "map '%s' -> 'above'",
    async (op) => {
      const alarm = await alarmWithOperator(op);
      expect(alarm.comparisonOperator).toBe('above');
    },
  );

  it.each(['LessThanThreshold', 'LessThanOrEqualToThreshold', 'LessThanLowerThreshold'])(
    "map '%s' -> 'below'",
    async (op) => {
      const alarm = await alarmWithOperator(op);
      expect(alarm.comparisonOperator).toBe('below');
    },
  );

  it("map 'LessThanLowerOrGreaterThanUpperThreshold' (a two-sided band) -> undefined (no single direction)", async () => {
    const alarm = await alarmWithOperator('LessThanLowerOrGreaterThanUpperThreshold');
    expect(alarm.comparisonOperator).toBeUndefined();
  });

  it('map undefined (alarm has no ComparisonOperator, e.g. a composite alarm) -> undefined', async () => {
    const alarm = await alarmWithOperator(undefined);
    expect(alarm.comparisonOperator).toBeUndefined();
  });
});
