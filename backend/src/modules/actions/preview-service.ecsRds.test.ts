import { describe, it, expect, vi, beforeEach } from 'vitest';

// Unit test for `buildActionPreviewDirect()` (ECS_ScaleOut/RDS_IncreaseStorage) — the "direct"
// preview variant, which does NOT go through recommendationId/assessment-report.json (used by the
// quick-action opened from Monitoring_Page). preview-service.ts reads the region via
// `config.awsRegion` — mock config.js before importing, following the same pattern as
// preview-service.property4.test.ts.
process.env.AWS_REGION = 'ap-southeast-1';
process.env.ASSESSMENT_BUCKET_NAME = 'test-assessment-bucket';
// preview-service.ts imports from `../governance/index.js`, whose barrel also evaluates
// `s3PolicyStore.ts` -> `assessment/infra-review-collector/clients.ts`, which reads
// AWS_ACCOUNT_ID directly from process.env at module scope and throws if missing.
process.env.AWS_ACCOUNT_ID = '123456789012';

vi.mock('../../config.js', () => ({
  config: {
    allowedOrigins: [],
    entraTenantId: 'test-tenant',
    entraClientId: 'test-client',
    allowedGroupIds: [],
    awsRegion: 'ap-southeast-1',
    costCacheParamName: 'test-cost-cache-param',
    assessmentBucketName: 'test-assessment-bucket',
    ec2StateManagerServiceTokenParamName: 'test-service-token-param',
    ec2StateManagerFunctionUrl: 'https://example.invalid/',
    actionExecutionFunctionName: 'test-action-execution-fn',
  },
  corsHeaders: () => ({}),
}));

const ec2SendMock = vi.fn();
const s3SendMock = vi.fn();
const ecsSendMock = vi.fn();
const rdsSendMock = vi.fn();
const autoscalingSendMock = vi.fn();

vi.mock('@aws-sdk/client-ec2', () => ({
  EC2Client: vi.fn().mockImplementation(() => ({ send: ec2SendMock })),
  DescribeVolumesCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'DescribeVolumes', input })),
}));

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: s3SendMock })),
  GetObjectCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'GetObject', input })),
  GetBucketLifecycleConfigurationCommand: vi
    .fn()
    .mockImplementation((input: unknown) => ({ __type: 'GetBucketLifecycleConfiguration', input })),
}));

vi.mock('@aws-sdk/client-ecs', () => ({
  ECSClient: vi.fn().mockImplementation(() => ({ send: ecsSendMock })),
  DescribeServicesCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'DescribeServices', input })),
}));

vi.mock('@aws-sdk/client-rds', () => ({
  RDSClient: vi.fn().mockImplementation(() => ({ send: rdsSendMock })),
  DescribeDBInstancesCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'DescribeDBInstances', input })),
}));

vi.mock('@aws-sdk/client-application-auto-scaling', () => ({
  ApplicationAutoScalingClient: vi.fn().mockImplementation(() => ({ send: autoscalingSendMock })),
  DescribeScalableTargetsCommand: vi
    .fn()
    .mockImplementation((input: unknown) => ({ __type: 'DescribeScalableTargets', input })),
}));

const { buildActionPreviewDirect } = await import('./preview-service.js');

beforeEach(() => {
  ec2SendMock.mockReset();
  s3SendMock.mockReset();
  ecsSendMock.mockReset();
  rdsSendMock.mockReset();
  autoscalingSendMock.mockReset();
});

describe('buildActionPreviewDirect — ECS_ScaleOut', () => {
  it('returns the correct preview, computing newDesiredCount from the registered maxCapacity', async () => {
    ecsSendMock.mockResolvedValue({ services: [{ status: 'ACTIVE', desiredCount: 4 }] });
    autoscalingSendMock.mockResolvedValue({ ScalableTargets: [{ MaxCapacity: 5 }] });

    const preview = await buildActionPreviewDirect('ECS_ScaleOut', 'abc-prod-ecs-cluster/abc-prod-ecs-service-api');

    expect(preview.actionType).toBe('ECS_ScaleOut');
    expect(preview.reversibilityClass).toBe('reversible');
    expect(preview.resource.id).toBe('abc-prod-ecs-cluster/abc-prod-ecs-service-api');
    expect(preview.params.currentDesiredCount).toBe(4);
    expect(preview.params.newDesiredCount).toBe(5); // capped by maxCapacity=5, even though +50% would be 6
  });

  it('still returns a valid preview when Application Auto Scaling can\'t be read (does not throw)', async () => {
    ecsSendMock.mockResolvedValue({ services: [{ status: 'ACTIVE', desiredCount: 2 }] });
    autoscalingSendMock.mockRejectedValue(new Error('boom'));

    const preview = await buildActionPreviewDirect('ECS_ScaleOut', 'cluster-x/service-y');

    expect(preview.params.currentDesiredCount).toBe(2);
    expect(preview.params.newDesiredCount).toBe(3); // ceil(2*0.5)=1, no maxCapacity limit
  });

  it('throws badRequest (400) when the service is not ACTIVE at preview time', async () => {
    ecsSendMock.mockResolvedValue({ services: [{ status: 'DRAINING', desiredCount: 2 }] });

    await expect(buildActionPreviewDirect('ECS_ScaleOut', 'cluster-x/service-y')).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it('throws badRequest when resourceId is not in the "<cluster>/<service>" format', async () => {
    await expect(buildActionPreviewDirect('ECS_ScaleOut', 'no-slash-here')).rejects.toMatchObject({
      statusCode: 400,
    });
  });
});

describe('buildActionPreviewDirect — RDS_IncreaseStorage', () => {
  it('returns the correct preview, increasing current storage by 20%', async () => {
    rdsSendMock.mockResolvedValue({ DBInstances: [{ AllocatedStorage: 100 }] });

    const preview = await buildActionPreviewDirect('RDS_IncreaseStorage', 'abc-prod-rds');

    expect(preview.actionType).toBe('RDS_IncreaseStorage');
    expect(preview.reversibilityClass).toBe('irreversible');
    expect(preview.params.currentAllocatedStorageGb).toBe(100);
    expect(preview.params.newAllocatedStorageGb).toBe(120);
  });

  it('throws badRequest when the DB instance is not found', async () => {
    rdsSendMock.mockResolvedValue({ DBInstances: [] });

    await expect(buildActionPreviewDirect('RDS_IncreaseStorage', 'unknown-db')).rejects.toMatchObject({
      statusCode: 400,
    });
  });
});

describe('buildActionPreviewDirect — invalid actionType', () => {
  it('throws badRequest for an unknown actionType', async () => {
    await expect(buildActionPreviewDirect('Not_A_Real_Action', 'x')).rejects.toMatchObject({ statusCode: 400 });
  });
});
