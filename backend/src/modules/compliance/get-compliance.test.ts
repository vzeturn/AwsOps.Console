import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../config.js', () => ({
  config: { allowedOrigins: [], awsRegion: 'ap-southeast-1', assessmentBucketName: 'test-assessment-bucket' },
  corsHeaders: () => ({}),
}));

const s3SendMock = vi.fn();
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: s3SendMock })),
  GetObjectCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
}));

const getComplianceDataMock = vi.fn();
vi.mock('./compliance-service.js', () => ({ getComplianceData: () => getComplianceDataMock() }));

const { handler } = await import('./get-compliance.js');

function buildEvent(): any {
  return { headers: {}, rawPath: '/compliance', requestContext: { http: { method: 'GET' } } };
}

beforeEach(() => {
  s3SendMock.mockReset();
  getComplianceDataMock.mockReset();
});

describe('handler (GET /compliance)', () => {
  it('returns data from the S3 cache when readable, does NOT call getComplianceData() directly', async () => {
    const cached = {
      recentBackupJobs: [],
      dlmPolicies: [],
      configRules: [],
      configStatus: 'evaluated',
      generatedAt: 'x',
      asOf: 'x',
    };
    s3SendMock.mockResolvedValue({ Body: { transformToString: async () => JSON.stringify(cached) } });

    const res = await handler(buildEvent());

    expect(JSON.parse((res as any).body as string)).toEqual(cached);
    expect(getComplianceDataMock).not.toHaveBeenCalled();
  });

  it('falls back to calling getComplianceData() directly when the S3 cache cannot be read', async () => {
    s3SendMock.mockRejectedValue(new Error('NoSuchKey'));
    const live = {
      recentBackupJobs: [],
      dlmPolicies: [],
      configRules: [],
      configStatus: 'evaluated',
      generatedAt: 'live',
      asOf: 'live',
    };
    getComplianceDataMock.mockResolvedValue(live);

    const res = await handler(buildEvent());

    expect(JSON.parse((res as any).body as string)).toEqual(live);
    expect(getComplianceDataMock).toHaveBeenCalledTimes(1);
  });
});
