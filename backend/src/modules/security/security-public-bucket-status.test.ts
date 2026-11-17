import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.AWS_REGION = 'ap-southeast-1';

const s3SendMock = vi.fn();
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: s3SendMock })),
  ListBucketsCommand: vi.fn().mockImplementation((input: unknown) => ({ __cmd: 'ListBuckets', input })),
  GetBucketPolicyStatusCommand: vi.fn().mockImplementation((input: unknown) => ({ __cmd: 'GetBucketPolicyStatus', input })),
  GetBucketTaggingCommand: vi.fn().mockImplementation((input: unknown) => ({ __cmd: 'GetBucketTagging', input })),
}));

const { collectBucketPublicStatuses } = await import('./security-public-bucket-status.js');

beforeEach(() => {
  s3SendMock.mockReset();
});

describe('collectBucketPublicStatuses', () => {
  it('reports buckets whose policy status could not be read as undetermined (never as not-public)', async () => {
    s3SendMock.mockImplementation(async (cmd: { __cmd: string; input: { Bucket?: string } }) => {
      if (cmd.__cmd === 'ListBuckets') return { Buckets: [{ Name: 'ok-bucket' }, { Name: 'flaky-bucket' }] };
      if (cmd.__cmd === 'GetBucketPolicyStatus') {
        if (cmd.input.Bucket === 'flaky-bucket') return Promise.reject(Object.assign(new Error('throttled'), { name: 'SlowDown' }));
        return { PolicyStatus: { IsPublic: true } };
      }
      return { TagSet: [{ Key: 'DataClass', Value: 'public' }] };
    });

    const result = await collectBucketPublicStatuses();

    expect(result.statuses).toEqual([{ bucketName: 'ok-bucket', isPublic: true, dataClassTagValue: 'public' }]);
    expect(result.undetermined).toEqual(['flaky-bucket']);
  });
});
