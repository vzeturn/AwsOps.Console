import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AssessmentReport } from '@ops-dashboard/shared';

// Task 9.3: unit test for assessment-service.ts
// Mock config.ts to avoid depending on required environment variables (readRequiredEnv in
// config.ts throws immediately on module load if an env var is missing) — this service only needs
// awsRegion/assessmentBucketName.
vi.mock('../../config.js', () => ({
  config: {
    awsRegion: 'ap-southeast-1',
    assessmentBucketName: 'assessment-report-bucket',
  },
}));

const s3SendMock = vi.fn();

// GetObjectCommand is mocked as an object with __type so s3SendMock can distinguish it (same
// pattern as storage-collector.test.ts) — even though assessment-service.ts only calls 1 kind of command.
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: s3SendMock })),
  GetObjectCommand: vi
    .fn()
    .mockImplementation((input: { Bucket: string; Key: string }) => ({ __type: 'GetObject', input })),
}));

// Import after the mocks are declared (vi.mock is hoisted to the top by vitest).
const { getAssessmentData } = await import('./assessment-service.js');

const SAMPLE_REPORT: AssessmentReport = {
  account: '123456789012',
  region: 'ap-southeast-1',
  periodStart: '2025-01-01',
  periodEnd: '2025-01-31',
  generatedAt: '2025-02-01T00:00:00.000Z',
  compute: {
    lambda: [
      {
        functionName: 'my-function',
        region: 'ap-southeast-1',
        memoryMb: 128,
        avgDurationMs: 120,
        invocationsInPeriod: 5,
        threshold: { level: 'ok', reason: 'invocationsInPeriod >= 10' },
      },
    ],
  },
  database: {},
  networking: { natGateways: [] },
  storage: { s3Buckets: [], ebsVolumes: [] },
  savingsPlans: { coverageByService: [] },
  backup: { protectionGaps: [] },
  recommendations: [],
};

beforeEach(() => {
  s3SendMock.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('getAssessmentData', () => {
  it('S3 object exists and returns valid JSON → returns that exact AssessmentReport', async () => {
    s3SendMock.mockImplementation(async (command: { __type: string; input?: { Bucket?: string; Key?: string } }) => {
      expect(command.__type).toBe('GetObject');
      expect(command.input).toMatchObject({
        Bucket: 'assessment-report-bucket',
        Key: 'assessment-report.json',
      });
      return {
        Body: {
          transformToString: async () => JSON.stringify(SAMPLE_REPORT),
        },
      };
    });

    const result = await getAssessmentData();

    expect(result).toEqual(SAMPLE_REPORT);
  });

  it('S3 GetObjectCommand throws an error (e.g. NoSuchKey) → returns a valid empty AssessmentReport, does NOT throw', async () => {
    s3SendMock.mockImplementation(async () => {
      const err = new Error('The specified key does not exist.');
      err.name = 'NoSuchKey';
      throw err;
    });

    const result = await getAssessmentData();

    expect(result).toEqual({
      account: '',
      region: 'ap-southeast-1',
      periodStart: '',
      periodEnd: '',
      generatedAt: '',
      compute: { lambda: [] },
      database: {},
      networking: { natGateways: [] },
      storage: { s3Buckets: [], ebsVolumes: [] },
      savingsPlans: { coverageByService: [] },
      backup: { protectionGaps: [] },
      recommendations: [],
    });
  });
});
