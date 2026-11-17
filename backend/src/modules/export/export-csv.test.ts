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
vi.mock('../infra/infra-service.js', () => ({ getInfraData: () => getInfraDataMock() }));

const getComplianceDataMock = vi.fn();
vi.mock('../compliance/compliance-service.js', () => ({ getComplianceData: () => getComplianceDataMock() }));

vi.mock('../cost/cost-service.js', () => ({ getCostData: vi.fn() }));

const { handler } = await import('./export-csv.js');

function buildEvent(): any {
  return { headers: {}, rawPath: '/export/infra', requestContext: { http: { method: 'GET' } } };
}

const CACHED_INFRA = {
  ec2: [{ instanceId: 'i-1', name: 'web', state: 'running', threshold: { level: 'ok', reason: 'fine' } }],
  rds: [],
  alb: [],
  generatedAt: '2026-08-24T00:00:00.000Z',
  asOf: '2026-08-24T00:00:00.000Z',
};

const CACHED_COMPLIANCE = {
  recentBackupJobs: [],
  dlmPolicies: [],
  configRules: [],
  configStatus: 'evaluated',
  generatedAt: '2026-08-24T01:00:00.000Z',
  asOf: '2026-08-24T01:00:00.000Z',
};

beforeEach(() => {
  s3SendMock.mockReset();
  getInfraDataMock.mockReset();
  getComplianceDataMock.mockReset();
});

/**
 * Regression test for I3: CSV export used to always call AWS Describe directly while `GET /infra`
 * and `GET /compliance` read from the S3 cache — the downloaded CSV could be a DIFFERENT snapshot
 * than what the user was looking at in the table. Now both share `readCachedJson()` and the CSV
 * writes an `as_of` field to self-describe which snapshot it used.
 */
describe('handler (GET /export/infra)', () => {
  it('uses the S3 cache when readable, does NOT call getInfraData(), and writes the cache as_of', async () => {
    s3SendMock.mockResolvedValue({ Body: { transformToString: async () => JSON.stringify(CACHED_INFRA) } });

    const res = (await handler(buildEvent(), 'infra')) as { statusCode: number; body: string };

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('ec2,i-1,web,running,ok,fine');
    expect(res.body).toContain('as_of,2026-08-24T00:00:00.000Z');
    expect(getInfraDataMock).not.toHaveBeenCalled();
  });

  it('falls back to getInfraData() when the cache cannot be read', async () => {
    s3SendMock.mockRejectedValue(new Error('NoSuchKey'));
    getInfraDataMock.mockResolvedValue({ ...CACHED_INFRA, ec2: [], asOf: 'live' });

    const res = (await handler(buildEvent(), 'infra')) as { body: string };

    expect(getInfraDataMock).toHaveBeenCalledTimes(1);
    expect(res.body).toContain('as_of,live');
  });
});

describe('handler (GET /export/compliance)', () => {
  it('uses the S3 cache when readable and writes the cache as_of', async () => {
    s3SendMock.mockResolvedValue({ Body: { transformToString: async () => JSON.stringify(CACHED_COMPLIANCE) } });

    const res = (await handler(buildEvent(), 'compliance')) as { body: string };

    expect(res.body).toContain('as_of,2026-08-24T01:00:00.000Z');
    expect(getComplianceDataMock).not.toHaveBeenCalled();
  });

  it('falls back to getComplianceData() when the cache cannot be read', async () => {
    s3SendMock.mockRejectedValue(new Error('NoSuchKey'));
    getComplianceDataMock.mockResolvedValue({ ...CACHED_COMPLIANCE, asOf: 'live' });

    const res = (await handler(buildEvent(), 'compliance')) as { body: string };

    expect(getComplianceDataMock).toHaveBeenCalledTimes(1);
    expect(res.body).toContain('as_of,live');
  });
});
