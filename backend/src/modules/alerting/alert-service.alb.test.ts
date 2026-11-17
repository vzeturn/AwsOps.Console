import { describe, it, expect, vi, beforeEach } from 'vitest';

// BUG FIX: an ALB alarm (e.g. "abc-prod-alb-unhealthy-hosts") always fell into "Other Alerts"
// (couldn't identify an online resource) even though that ALB WAS online — root cause: CloudWatch
// returns the `LoadBalancer` dimension as an ARN suffix in the form "app/<name>/<id>" (the REAL
// value used to query GetMetricData/create the ALB's alarm — see extractAlbArnSuffix in
// infra-service.ts), but inferRelatedResourceId() used to use that value DIRECTLY as
// relatedResourceId, which never matched the ALB's real resourceId (just the bare name, e.g.
// "abc-prod-alb"). Result: the ALB was never considered "having a problem", and the target group
// breakdown (requirement "ALB should show its target group if there's a problem") had nowhere to
// render because the ALB card itself was never rendered.
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

describe('getAlerts() — ALB relatedResourceId inference (BUG FIX: ARN suffix -> bare name)', () => {
  it('correctly infers relatedResourceId = bare ALB name from a LoadBalancer dimension shaped "app/<name>/<id>"', async () => {
    cloudwatchSendMock.mockResolvedValue({
      MetricAlarms: [
        {
          AlarmName: 'abc-prod-alb-unhealthy-hosts',
          StateValue: 'ALARM',
          Namespace: 'AWS/ApplicationELB',
          MetricName: 'UnHealthyHostCount',
          Dimensions: [{ Name: 'LoadBalancer', Value: 'app/abc-prod-alb/0123456789abcdef' }],
        },
      ],
    });

    const result = await getAlerts();

    expect(result).toHaveLength(1);
    expect(result[0].relatedResourceId).toBe('abc-prod-alb');
  });

  it('returns undefined when the LoadBalancer dimension value does not match the "app/<name>/<id>" structure (no throw, no guessing)', async () => {
    cloudwatchSendMock.mockResolvedValue({
      MetricAlarms: [
        {
          AlarmName: 'malformed-alb-alarm',
          StateValue: 'OK',
          Namespace: 'AWS/ApplicationELB',
          MetricName: 'UnHealthyHostCount',
          Dimensions: [{ Name: 'LoadBalancer', Value: 'not-a-valid-arn-suffix' }],
        },
      ],
    });

    const result = await getAlerts();

    expect(result[0].relatedResourceId).toBeUndefined();
  });

  it('works correctly for a Network Load Balancer ("net" prefix instead of "app") — same 3-part structure', async () => {
    cloudwatchSendMock.mockResolvedValue({
      MetricAlarms: [
        {
          AlarmName: 'nlb-alarm',
          StateValue: 'OK',
          Namespace: 'AWS/NetworkELB',
          MetricName: 'HealthyHostCount',
          Dimensions: [{ Name: 'LoadBalancer', Value: 'net/my-nlb/0123456789abcdef' }],
        },
      ],
    });

    const result = await getAlerts();

    expect(result[0].relatedResourceId).toBe('my-nlb');
  });
});
