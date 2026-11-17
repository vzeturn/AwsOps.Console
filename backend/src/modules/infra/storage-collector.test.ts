import { describe, it, expect, vi, beforeEach } from 'vitest';

// Task 6.8: unit test for storage-collector.ts
// The collector reads the region directly from process.env.AWS_REGION (the Lambda runtime always
// sets this variable itself) — set it before importing the module; no more mocking config.ts
// (the collector doesn't import config.ts).
process.env.AWS_REGION = 'ap-southeast-1';

const s3SendMock = vi.fn();
const ec2SendMock = vi.fn();
const cloudwatchSendMock = vi.fn();

// Commands are mocked as objects with __type so s3SendMock/ec2SendMock can distinguish between
// them (ListBucketsCommand vs GetBucketLifecycleConfigurationCommand both call through the same s3.send()).
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: s3SendMock })),
  ListBucketsCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'ListBuckets', input })),
  GetBucketLifecycleConfigurationCommand: vi
    .fn()
    .mockImplementation((input: { Bucket: string }) => ({ __type: 'GetBucketLifecycleConfiguration', input })),
}));

vi.mock('@aws-sdk/client-ec2', () => ({
  EC2Client: vi.fn().mockImplementation(() => ({ send: ec2SendMock })),
  DescribeVolumesCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'DescribeVolumes', input })),
}));

vi.mock('@aws-sdk/client-cloudwatch', () => ({
  CloudWatchClient: vi.fn().mockImplementation(() => ({ send: cloudwatchSendMock })),
  GetMetricDataCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'GetMetricData', input })),
}));

// Import after the mocks are declared (vi.mock is hoisted to the top by vitest).
const { getStorageData } = await import('./storage-collector.js');

beforeEach(() => {
  s3SendMock.mockReset();
  ec2SendMock.mockReset();
  cloudwatchSendMock.mockReset();
  // Default: no volumes, CloudWatch returns no metrics — tests override as needed.
  ec2SendMock.mockResolvedValue({ Volumes: [] });
  cloudwatchSendMock.mockResolvedValue({ MetricDataResults: [] });
});

describe('getStorageData', () => {
  it('bucket has no lifecycle policy (GetBucketLifecycleConfiguration throws NoSuchLifecycleConfiguration) → hasLifecyclePolicy: false', async () => {
    s3SendMock.mockImplementation(async (command: { __type: string; input?: { Bucket?: string } }) => {
      if (command.__type === 'ListBuckets') {
        return { Buckets: [{ Name: 'bucket-no-lifecycle' }] };
      }
      if (command.__type === 'GetBucketLifecycleConfiguration') {
        const err = new Error('The lifecycle configuration does not exist');
        err.name = 'NoSuchLifecycleConfiguration';
        throw err;
      }
      throw new Error(`Unexpected command: ${command.__type}`);
    });

    const result = await getStorageData();

    expect(result.s3Buckets).toHaveLength(1);
    expect(result.s3Buckets[0]).toMatchObject({
      bucketName: 'bucket-no-lifecycle',
      region: 'ap-southeast-1',
      hasLifecyclePolicy: false,
    });
  });

  it('EBS volume is not attached (no Attachments, State other than in-use) → attached: false', async () => {
    s3SendMock.mockResolvedValue({ Buckets: [] });
    ec2SendMock.mockResolvedValue({
      Volumes: [
        {
          VolumeId: 'vol-unattached-1',
          VolumeType: 'gp3',
          Size: 100,
          State: 'available',
          Attachments: [],
        },
      ],
    });

    const result = await getStorageData();

    expect(result.ebsVolumes).toHaveLength(1);
    expect(result.ebsVolumes[0]).toMatchObject({
      volumeId: 'vol-unattached-1',
      region: 'ap-southeast-1',
      volumeType: 'gp3',
      sizeGb: 100,
      attached: false,
    });
  });

  it('bucket HAS a lifecycle policy (Rules not empty) → hasLifecyclePolicy: true', async () => {
    s3SendMock.mockImplementation(async (command: { __type: string; input?: { Bucket?: string } }) => {
      if (command.__type === 'ListBuckets') {
        return { Buckets: [{ Name: 'bucket-with-lifecycle' }] };
      }
      if (command.__type === 'GetBucketLifecycleConfiguration') {
        return { Rules: [{ ID: 'expire-old-versions', Status: 'Enabled' }] };
      }
      throw new Error(`Unexpected command: ${command.__type}`);
    });

    const result = await getStorageData();

    expect(result.s3Buckets).toHaveLength(1);
    expect(result.s3Buckets[0]).toMatchObject({
      bucketName: 'bucket-with-lifecycle',
      hasLifecyclePolicy: true,
    });
  });
});
