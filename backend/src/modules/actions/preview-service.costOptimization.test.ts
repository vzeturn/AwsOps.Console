import { describe, it, expect, vi, beforeEach } from 'vitest';

// Unit test for buildActionPreviewDirect() with the 3 new cost-optimization actionTypes:
// EBS_ModifyVolumeType/CloudWatchLogGroup_SetRetention/ElasticIp_Release — following the same
// pattern as preview-service.ecsRds.test.ts.
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
const cloudwatchLogsSendMock = vi.fn();

vi.mock('@aws-sdk/client-ec2', () => ({
  EC2Client: vi.fn().mockImplementation(() => ({ send: ec2SendMock })),
  DescribeVolumesCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'DescribeVolumes', input })),
  DescribeAddressesCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'DescribeAddresses', input })),
}));

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: s3SendMock })),
  GetObjectCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'GetObject', input })),
  GetBucketLifecycleConfigurationCommand: vi
    .fn()
    .mockImplementation((input: unknown) => ({ __type: 'GetBucketLifecycleConfiguration', input })),
}));

vi.mock('@aws-sdk/client-cloudwatch-logs', () => ({
  CloudWatchLogsClient: vi.fn().mockImplementation(() => ({ send: cloudwatchLogsSendMock })),
  DescribeLogGroupsCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'DescribeLogGroups', input })),
}));

const { buildActionPreviewDirect } = await import('./preview-service.js');

beforeEach(() => {
  ec2SendMock.mockReset();
  s3SendMock.mockReset();
  cloudwatchLogsSendMock.mockReset();
});

describe('buildActionPreviewDirect — EBS_ModifyVolumeType', () => {
  it('returns the correct preview when the volume is gp2', async () => {
    ec2SendMock.mockResolvedValue({ Volumes: [{ VolumeType: 'gp2' }] });

    const preview = await buildActionPreviewDirect('EBS_ModifyVolumeType', 'vol-123');

    expect(preview.actionType).toBe('EBS_ModifyVolumeType');
    expect(preview.reversibilityClass).toBe('reversible');
    expect(preview.params).toEqual({ currentVolumeType: 'gp2', newVolumeType: 'gp3' });
  });

  it('throws badRequest when the volume is NOT gp2', async () => {
    ec2SendMock.mockResolvedValue({ Volumes: [{ VolumeType: 'gp3' }] });

    await expect(buildActionPreviewDirect('EBS_ModifyVolumeType', 'vol-123')).rejects.toMatchObject({ statusCode: 400 });
  });

  it('throws badRequest when the volume is not found', async () => {
    ec2SendMock.mockResolvedValue({ Volumes: [] });

    await expect(buildActionPreviewDirect('EBS_ModifyVolumeType', 'vol-missing')).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('buildActionPreviewDirect — CloudWatchLogGroup_SetRetention', () => {
  it('returns the correct preview when the log group has no retention yet', async () => {
    cloudwatchLogsSendMock.mockResolvedValue({ logGroups: [{ logGroupName: '/aws/lambda/foo', retentionInDays: undefined }] });

    const preview = await buildActionPreviewDirect('CloudWatchLogGroup_SetRetention', '/aws/lambda/foo');

    expect(preview.actionType).toBe('CloudWatchLogGroup_SetRetention');
    expect(preview.reversibilityClass).toBe('reversible');
    expect(preview.params).toEqual({ newRetentionDays: 90 });
  });

  it('throws badRequest when the log group ALREADY has a retention policy', async () => {
    cloudwatchLogsSendMock.mockResolvedValue({ logGroups: [{ logGroupName: '/aws/lambda/foo', retentionInDays: 30 }] });

    await expect(buildActionPreviewDirect('CloudWatchLogGroup_SetRetention', '/aws/lambda/foo')).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it('throws badRequest when the log group is not found', async () => {
    cloudwatchLogsSendMock.mockResolvedValue({ logGroups: [] });

    await expect(buildActionPreviewDirect('CloudWatchLogGroup_SetRetention', '/aws/lambda/missing')).rejects.toMatchObject({
      statusCode: 400,
    });
  });
});

describe('buildActionPreviewDirect — ElasticIp_Release', () => {
  it('returns the correct preview when the EIP is not associated with any resource', async () => {
    ec2SendMock.mockResolvedValue({ Addresses: [{ PublicIp: '1.2.3.4', AssociationId: undefined }] });

    const preview = await buildActionPreviewDirect('ElasticIp_Release', 'eipalloc-1');

    expect(preview.actionType).toBe('ElasticIp_Release');
    expect(preview.reversibilityClass).toBe('irreversible');
    expect(preview.params).toEqual({ publicIp: '1.2.3.4' });
  });

  it('throws badRequest when the EIP is ALREADY associated with a resource', async () => {
    ec2SendMock.mockResolvedValue({ Addresses: [{ PublicIp: '1.2.3.4', AssociationId: 'eipassoc-1' }] });

    await expect(buildActionPreviewDirect('ElasticIp_Release', 'eipalloc-1')).rejects.toMatchObject({ statusCode: 400 });
  });

  it('throws badRequest when the allocationId is not found', async () => {
    ec2SendMock.mockResolvedValue({ Addresses: [] });

    await expect(buildActionPreviewDirect('ElasticIp_Release', 'eipalloc-missing')).rejects.toMatchObject({ statusCode: 400 });
  });
});
