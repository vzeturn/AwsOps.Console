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

const getInfraDataMock = vi.fn();
vi.mock('./infra-service.js', () => ({ getInfraData: () => getInfraDataMock() }));

const { handler } = await import('./get-infra.js');

function buildEvent(): any {
  return { headers: {}, rawPath: '/infra', requestContext: { http: { method: 'GET' } } };
}

beforeEach(() => {
  s3SendMock.mockReset();
  getInfraDataMock.mockReset();
});

describe('handler (GET /infra)', () => {
  it('returns data from the S3 cache when it can be read, does NOT call getInfraData() directly', async () => {
    const cached = { ec2: [], rds: [], alb: [], generatedAt: '2026-08-24T00:00:00.000Z', asOf: '2026-08-24T00:00:00.000Z' };
    s3SendMock.mockResolvedValue({ Body: { transformToString: async () => JSON.stringify(cached) } });

    const res = await handler(buildEvent());

    expect(JSON.parse((res as any).body as string)).toEqual(cached);
    expect(getInfraDataMock).not.toHaveBeenCalled();
  });

  it('falls back to calling getInfraData() directly when the S3 cache cannot be read', async () => {
    s3SendMock.mockRejectedValue(new Error('NoSuchKey'));
    const live = { ec2: [], rds: [], alb: [], generatedAt: 'live', asOf: 'live' };
    getInfraDataMock.mockResolvedValue(live);

    const res = await handler(buildEvent());

    expect(JSON.parse((res as any).body as string)).toEqual(live);
    expect(getInfraDataMock).toHaveBeenCalledTimes(1);
  });
});
