import { describe, it, expect, vi, beforeEach } from 'vitest';

// Task 5.4: unit test for the "No alerts" (empty state) case of `getAlerts()`
// (Task 5.1, fully implemented in alert-service.ts). The UI empty state ("No alerts")
// is a frontend concern, covered separately in AlertPanel.test.tsx — this test only checks that
// the backend `getAlerts()` returns an empty array when `DescribeAlarms` has no alarms.
//
// Validates: Requirements 9.4

// alert-service.ts reads the region directly from process.env.AWS_REGION — set it before
// importing (same as alert-service.property7/8.test.ts).
process.env.AWS_REGION = 'ap-southeast-1';
// alert-service.ts statically imports `buildConsoleLink` from monitoring-service.ts, which
// statically imports threshold-history-service.ts (throws at module scope if
// ASSESSMENT_BUCKET_NAME is missing) — set it before importing.
process.env.ASSESSMENT_BUCKET_NAME = 'test-assessment-bucket';

// monitoring-service.ts statically imports `loadAlb` from infra-service.ts, which creates an AWS
// SDK client at module scope that reads `config.awsRegion` (readRequiredEnv throws if the env var
// is missing) — mock config.js following the same pattern as alert-service.property7/8.test.ts so
// the import doesn't throw.
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

// alert-service.ts directly uses CloudWatchClient/DescribeAlarmsCommand — mock send() to return
// { MetricAlarms: [] } for the empty case.
vi.mock('@aws-sdk/client-cloudwatch', () => ({
  CloudWatchClient: vi.fn().mockImplementation(() => ({ send: cloudwatchSendMock })),
  DescribeAlarmsCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'DescribeAlarms', input })),
  GetMetricDataCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
  ListMetricsCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
}));

// monitoring-service.ts (imported indirectly via buildConsoleLink) creates EC2Client/RDSClient/
// ElasticLoadBalancingV2Client/S3Client at module scope — unused in this test but must be mocked
// so importing alert-service.js doesn't construct real clients.
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

// Import after the mocks are declared (vi.mock is hoisted to the top by vitest).
const { getAlerts } = await import('./alert-service.js');

beforeEach(() => {
  cloudwatchSendMock.mockReset();
  ec2SendMock.mockReset();
  rdsSendMock.mockReset();
  elbSendMock.mockReset();
  s3SendMock.mockReset();
});

describe('getAlerts() empty state ("No alerts")', () => {
  it('returns an empty array when DescribeAlarms has no alarms, without throwing', async () => {
    cloudwatchSendMock.mockResolvedValue({ MetricAlarms: [] });

    const result = await getAlerts();

    expect(result).toEqual([]);
  });
});
