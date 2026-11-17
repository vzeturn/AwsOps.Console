import { describe, it, expect, vi, beforeEach } from 'vitest';

// Task 6.5: unit test for threshold-history-service.ts — reading a non-existent S3 object
// (NoSuchKey) and a generic S3 read error (not NoSuchKey).
//
// The module reads process.env.ASSESSMENT_BUCKET_NAME/AWS_REGION right at module scope
// (fail-loud if missing) — set them before importing, following the same pattern as
// property12/13/14.test.ts.
process.env.AWS_REGION = 'ap-southeast-1';
process.env.ASSESSMENT_BUCKET_NAME = 'test-assessment-bucket';

const s3SendMock = vi.fn();

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: s3SendMock })),
  GetObjectCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'GetObject', input })),
  PutObjectCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'PutObject', input })),
}));

// Import after the mocks/env are declared (vi.mock is hoisted to the top by vitest).
const { getHistory, recordIfChanged } = await import('./threshold-history-service.js');

beforeEach(() => {
  s3SendMock.mockReset();
});

// _Requirements: 14.1 (Design Error Handling: ThresholdHistory S3 object doesn't exist)

describe('threshold-history-service — reading a non-existent S3 object / read error (Task 6.5)', () => {
  it('getHistory() returns [] when GetObjectCommand rejects with NoSuchKey, without throwing', async () => {
    s3SendMock.mockImplementation(async (command: { __type: string }) => {
      if (command.__type === 'GetObject') {
        throw Object.assign(new Error('The specified key does not exist.'), { name: 'NoSuchKey' });
      }
      throw new Error(`unexpected command ${command.__type}`);
    });

    await expect(getHistory('ec2', 'i-test123', 'CPUUtilization')).resolves.toEqual([]);
  });

  it('recordIfChanged() does not throw when GetObjectCommand rejects with NoSuchKey, and writes (PUT) a new baseline', async () => {
    let putBody: string | undefined;

    s3SendMock.mockImplementation(async (command: { __type: string; input?: { Body?: string } }) => {
      if (command.__type === 'GetObject') {
        throw Object.assign(new Error('The specified key does not exist.'), { name: 'NoSuchKey' });
      }
      if (command.__type === 'PutObject') {
        putBody = command.input?.Body;
        return {};
      }
      throw new Error(`unexpected command ${command.__type}`);
    });

    await expect(recordIfChanged('ec2', 'i-test123', 'CPUUtilization', 50, 'warn')).resolves.toBeUndefined();

    // A completely new resource (no prior history) -> readStore() returns an empty store ->
    // previousLevel === undefined !== 'warn' -> seeds the baseline and PUTs (no real prior
    // evaluation, so no history entry — see `hadPriorEvaluation` in threshold-history-service.ts).
    const putCalls = s3SendMock.mock.calls.filter(([cmd]) => cmd.__type === 'PutObject');
    expect(putCalls).toHaveLength(1);
    expect(putBody).not.toBeUndefined();

    const stored = JSON.parse(putBody!) as { lastLevels: Record<string, string>; history: unknown[] };
    expect(stored.lastLevels.CPUUtilization).toBe('warn');
    expect(stored.history).toHaveLength(0);
  });

  it('getHistory() returns [] when GetObjectCommand rejects with a generic error (not NoSuchKey), without throwing', async () => {
    s3SendMock.mockImplementation(async (command: { __type: string }) => {
      if (command.__type === 'GetObject') {
        throw Object.assign(new Error('Access Denied'), { name: 'AccessDenied' });
      }
      throw new Error(`unexpected command ${command.__type}`);
    });

    await expect(getHistory('rds', 'db-test', 'FreeableMemory')).resolves.toEqual([]);
  });

  it('recordIfChanged() does not throw when GetObjectCommand rejects with a generic error (not NoSuchKey)', async () => {
    s3SendMock.mockImplementation(async (command: { __type: string }) => {
      if (command.__type === 'GetObject') {
        throw new Error('Network error');
      }
      if (command.__type === 'PutObject') {
        return {};
      }
      throw new Error(`unexpected command ${command.__type}`);
    });

    await expect(recordIfChanged('rds', 'db-test', 'FreeableMemory', 90, 'critical')).resolves.toBeUndefined();
  });
});
