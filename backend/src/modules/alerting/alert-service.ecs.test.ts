import { describe, it, expect, vi, beforeEach } from 'vitest';

// Unit test for `inferRelatedResourceId()` handling ECS_Service (2-dimension
// ClusterName+ServiceName) — added when ECS was added to Monitoring_Page. Follows the same mock
// pattern as alert-service.test.ts.
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
const ecsSendMock = vi.fn();
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

vi.mock('@aws-sdk/client-ecs', () => ({
  ECSClient: vi.fn().mockImplementation(() => ({ send: ecsSendMock })),
  ListClustersCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
  ListServicesCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
  DescribeServicesCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
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

describe('getAlerts() — ECS_Service relatedResourceId inference (ClusterName+ServiceName)', () => {
  it('infers relatedResourceId as "<clusterName>/<serviceName>" when the alarm has both ECS dimensions', async () => {
    cloudwatchSendMock.mockResolvedValue({
      MetricAlarms: [
        {
          AlarmName: 'TargetTracking-service/abc-prod-ecs-cluster/abc-prod-ecs-service-api-AlarmLow',
          StateValue: 'ALARM',
          Namespace: 'AWS/ECS',
          MetricName: 'CPUUtilization',
          Dimensions: [
            { Name: 'ClusterName', Value: 'abc-prod-ecs-cluster' },
            { Name: 'ServiceName', Value: 'abc-prod-ecs-service-api' },
          ],
        },
      ],
    });

    const result = await getAlerts();

    expect(result).toHaveLength(1);
    expect(result[0].relatedResourceId).toBe('abc-prod-ecs-cluster/abc-prod-ecs-service-api');
  });

  it('returns undefined when the alarm has only 1 of the 2 ECS dimensions (missing ClusterName)', async () => {
    cloudwatchSendMock.mockResolvedValue({
      MetricAlarms: [
        {
          AlarmName: 'partial-ecs-alarm',
          StateValue: 'OK',
          Namespace: 'AWS/ECS',
          MetricName: 'CPUUtilization',
          Dimensions: [{ Name: 'ServiceName', Value: 'abc-prod-ecs-service-api' }],
        },
      ],
    });

    const result = await getAlerts();

    expect(result[0].relatedResourceId).toBeUndefined();
  });
});
