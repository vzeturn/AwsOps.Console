import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.AWS_REGION = 'ap-southeast-1';
process.env.ASSESSMENT_BUCKET_NAME = 'test-assessment-bucket';

const s3SendMock = vi.fn();
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: s3SendMock })),
  PutObjectCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
}));

const getInfraDataMock = vi.fn();
const getComplianceDataMock = vi.fn();
const collectTopologyMock = vi.fn();
vi.mock('./modules/infra/infra-service.js', () => ({ getInfraData: () => getInfraDataMock() }));
vi.mock('./modules/compliance/compliance-service.js', () => ({ getComplianceData: () => getComplianceDataMock() }));
vi.mock('./modules/infra/topology-collector.js', () => ({ collectTopology: () => collectTopologyMock() }));

const { handler } = await import('./infra-collector.js');

/**
 * Assert on WHICH cache keys were written rather than on how many writes happened.
 *
 * The count-based version of these tests broke the moment a third source (topology) was added, which
 * is the wrong failure: the property that actually matters is "each healthy source wrote its own
 * object, and a failing source did not overwrite anyone else's". Keys express that directly and stay
 * correct as sources are added.
 */
function writtenKeys(): string[] {
  return s3SendMock.mock.calls
    .map((call) => (call[0] as { input?: { Key?: string } })?.input?.Key)
    .filter((key): key is string => Boolean(key))
    .sort();
}

beforeEach(() => {
  s3SendMock.mockReset();
  getInfraDataMock.mockReset();
  getComplianceDataMock.mockReset();
  collectTopologyMock.mockReset();

  getInfraDataMock.mockResolvedValue({ ec2: [], rds: [], alb: [], generatedAt: 'x', asOf: 'x' });
  getComplianceDataMock.mockResolvedValue({
    recentBackupJobs: [],
    dlmPolicies: [],
    configRules: [],
    configStatus: 'evaluated',
    generatedAt: 'x',
    asOf: 'x',
  });
  collectTopologyMock.mockResolvedValue({
    region: 'ap-southeast-1',
    vpcs: [],
    resources: [],
    unplacedResources: [],
    generatedAt: 'x',
  });
  s3SendMock.mockResolvedValue({});
});

describe('infra-collector handler', () => {
  it('writes all three caches when every source succeeds', async () => {
    const result = await handler();

    expect(result).toEqual({ ok: true });
    expect(writtenKeys()).toEqual(['compliance-cache.json', 'infra-cache.json', 'topology-cache.json']);
  });

  it('still writes the other caches when getComplianceData fails (partial failure, no throw)', async () => {
    getComplianceDataMock.mockRejectedValue(new Error('AWS Config not enabled'));

    const result = await handler();

    expect(result).toEqual({ ok: true });
    // The failing source wrote nothing, so its previous cache survives; the healthy ones still wrote.
    expect(writtenKeys()).toEqual(['infra-cache.json', 'topology-cache.json']);
  });

  it('a topology failure does not cost the infra or compliance cache', async () => {
    // Topology is the newest source and the most likely to hit a fresh permission gap; it must not be
    // able to take the two established tabs down with it.
    collectTopologyMock.mockRejectedValue(new Error('AccessDenied: DescribeRouteTables'));

    const result = await handler();

    expect(result).toEqual({ ok: true });
    expect(writtenKeys()).toEqual(['compliance-cache.json', 'infra-cache.json']);
  });

  it('a topology failure writes NOTHING for topology, leaving the previous map cache intact', async () => {
    // An empty map renders perfectly and claims "you have no infrastructure". Overwriting a good
    // cache with that would be worse than serving a stale map with a staleness banner.
    collectTopologyMock.mockRejectedValue(new Error('boom'));

    await handler();

    expect(writtenKeys()).not.toContain('topology-cache.json');
  });

  it('throws when ASSESSMENT_BUCKET_NAME is missing', async () => {
    const original = process.env.ASSESSMENT_BUCKET_NAME;
    delete process.env.ASSESSMENT_BUCKET_NAME;

    await expect(handler()).rejects.toThrow('ASSESSMENT_BUCKET_NAME');

    process.env.ASSESSMENT_BUCKET_NAME = original;
  });
});
