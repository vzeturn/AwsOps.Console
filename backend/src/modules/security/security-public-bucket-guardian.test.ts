import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.AWS_REGION = 'ap-southeast-1';

const s3SendMock = vi.fn();

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: s3SendMock })),
  ListBucketsCommand: vi.fn().mockImplementation((input: unknown) => ({ __cmd: 'ListBuckets', input })),
  GetBucketPolicyStatusCommand: vi.fn().mockImplementation((input: unknown) => ({ __cmd: 'GetBucketPolicyStatus', input })),
  GetBucketTaggingCommand: vi.fn().mockImplementation((input: unknown) => ({ __cmd: 'GetBucketTagging', input })),
}));

const postDiscordEmbedsMock = vi.fn();
vi.mock('../alerting/discordWebhook.js', () => ({ postDiscordEmbeds: postDiscordEmbedsMock }));

const { handler, findUnexplainedPublicBuckets } = await import('./security-public-bucket-guardian.js');

beforeEach(() => {
  s3SendMock.mockReset();
  postDiscordEmbedsMock.mockReset();
});

describe('findUnexplainedPublicBuckets', () => {
  it('flags a public bucket with no DataClass=public tag', () => {
    const result = findUnexplainedPublicBuckets([
      { bucketName: 'unexplained', isPublic: true, dataClassTagValue: undefined },
      { bucketName: 'tagged-public', isPublic: true, dataClassTagValue: 'public' },
      { bucketName: 'private', isPublic: false, dataClassTagValue: undefined },
      { bucketName: 'wrong-tag', isPublic: true, dataClassTagValue: 'internal' },
    ]);
    expect(result.map((r) => r.bucketName)).toEqual(['unexplained', 'wrong-tag']);
  });
});

describe('handler', () => {
  it('flags public buckets confirmed via acmeew-prod-assets/acme.s3.services.bot-style data but tagged public are left alone', async () => {
    s3SendMock.mockImplementation((command: { __cmd: string; input?: { Bucket?: string } }) => {
      if (command.__cmd === 'ListBuckets') {
        return Promise.resolve({ Buckets: [{ Name: 'acmeew-prod-assets' }, { Name: 'acme.s3.services.bot' }, { Name: 'private-bucket' }] });
      }
      if (command.__cmd === 'GetBucketPolicyStatus') {
        if (command.input?.Bucket === 'private-bucket') return Promise.resolve({ PolicyStatus: { IsPublic: false } });
        return Promise.resolve({ PolicyStatus: { IsPublic: true } });
      }
      if (command.__cmd === 'GetBucketTagging') {
        return Promise.resolve({ TagSet: [{ Key: 'DataClass', Value: 'public' }] });
      }
      return Promise.resolve({});
    });

    const result = await handler();

    expect(result).toEqual({ ok: true, checked: 3, unexplainedPublic: 0 });
    expect(postDiscordEmbedsMock).not.toHaveBeenCalled();
  });

  it('flags a bucket that is public but has NO DataClass tag at all (NoSuchTagSet)', async () => {
    s3SendMock.mockImplementation((command: { __cmd: string }) => {
      if (command.__cmd === 'ListBuckets') return Promise.resolve({ Buckets: [{ Name: 'oops-public' }] });
      if (command.__cmd === 'GetBucketPolicyStatus') return Promise.resolve({ PolicyStatus: { IsPublic: true } });
      if (command.__cmd === 'GetBucketTagging') {
        const err = new Error('NoSuchTagSet');
        err.name = 'NoSuchTagSet';
        return Promise.reject(err);
      }
      return Promise.resolve({});
    });

    const result = await handler();

    expect(result).toEqual({ ok: true, checked: 1, unexplainedPublic: 1 });
    expect(postDiscordEmbedsMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(postDiscordEmbedsMock.mock.calls[0][0])).toContain('oops-public');
  });

  it('treats NoSuchBucketPolicy as "not public" rather than an error', async () => {
    s3SendMock.mockImplementation((command: { __cmd: string }) => {
      if (command.__cmd === 'ListBuckets') return Promise.resolve({ Buckets: [{ Name: 'no-policy-bucket' }] });
      if (command.__cmd === 'GetBucketPolicyStatus') {
        const err = new Error('NoSuchBucketPolicy');
        err.name = 'NoSuchBucketPolicy';
        return Promise.reject(err);
      }
      return Promise.resolve({});
    });

    const result = await handler();

    expect(result).toEqual({ ok: true, checked: 1, unexplainedPublic: 0 });
    expect(postDiscordEmbedsMock).not.toHaveBeenCalled();
  });

  it('skips (does not flag) a bucket whose policy status could not be determined', async () => {
    s3SendMock.mockImplementation((command: { __cmd: string }) => {
      if (command.__cmd === 'ListBuckets') return Promise.resolve({ Buckets: [{ Name: 'unknown-bucket' }] });
      if (command.__cmd === 'GetBucketPolicyStatus') return Promise.reject(new Error('AccessDenied'));
      return Promise.resolve({});
    });

    const result = await handler();

    expect(result).toEqual({ ok: true, checked: 0, unexplainedPublic: 0 });
  });
});
