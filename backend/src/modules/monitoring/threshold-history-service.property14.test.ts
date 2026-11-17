import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import type { MonitoringResourceType, ThresholdLevel } from '@ops-dashboard/shared';

// Feature: realtime-monitoring-dashboard, Property 14: Threshold_History minimum retention is never violated
//
// For any ThresholdHistoryEntry with a given recorded timestamp, and any query/prune evaluation time
// that is less than 24 hours after that timestamp, the entry SHALL still be present in the result of
// getHistory (i.e. no pruning logic - RETENTION_MS in threshold-history-service.ts - SHALL remove the
// entry before the 24-hour minimum has elapsed).
//
// Validates: Requirements 14.2
//
// This is distinct from property13 (which tests exactness of the retained window at an arbitrary
// point, i.e. entries both inside and outside the window). This property stresses only the lower
// bound: for ANY delta strictly less than 24h, nothing is removed early.

process.env.AWS_REGION = 'ap-southeast-1';
process.env.ASSESSMENT_BUCKET_NAME = 'test-assessment-bucket';

const RETENTION_MS = 24 * 60 * 60 * 1000;

let storedBody: string | undefined;

const s3SendMock = vi.fn(async (command: unknown) => {
  const cmd = command as { __type: string; input: Record<string, unknown> };
  if (cmd.__type === 'getObject') {
    if (storedBody === undefined) {
      const err = new Error('NoSuchKey');
      err.name = 'NoSuchKey';
      throw err;
    }
    return { Body: { transformToString: async () => storedBody } };
  }
  if (cmd.__type === 'putObject') {
    storedBody = cmd.input.Body as string;
    return {};
  }
  throw new Error(`unexpected command ${cmd.__type}`);
});

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: s3SendMock })),
  GetObjectCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'getObject', input })),
  PutObjectCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'putObject', input })),
}));

const { getHistory } = await import('./threshold-history-service.js');

beforeEach(() => {
  storedBody = undefined;
  s3SendMock.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

const levelArb: fc.Arbitrary<ThresholdLevel> = fc.constantFrom('ok', 'warn', 'critical');
const resourceTypeArb: fc.Arbitrary<MonitoringResourceType> = fc.constantFrom('ec2', 'rds', 'alb', 'ebs');
// Exclude -0: JSON.stringify serializes -0 as "0", which would make a strict deep-equal
// comparison against the original entry spuriously fail (a JSON round-trip artifact, not a
// retention bug).
const valueArb = fc
  .float({ min: -1_000_000, max: 1_000_000, noNaN: true })
  .filter((v) => !Object.is(v, -0));

// Arbitrary recorded timestamp for the entry, and an arbitrary delta strictly less than 24h that
// "now" is ahead of it by.
const inputArb = fc.record({
  resourceType: resourceTypeArb,
  resourceId: fc.string({ minLength: 1 }).filter((s) => s.trim().length > 0),
  metric: fc.string({ minLength: 1 }).filter((s) => s.trim().length > 0),
  oldValue: valueArb,
  newValue: valueArb,
  oldLevel: levelArb,
  newLevel: levelArb,
  entryTimeMs: fc.integer({ min: 0, max: 2_000_000_000_000 }),
  deltaMs: fc.integer({ min: 0, max: RETENTION_MS - 1 }),
});

describe('getHistory (Property 14)', () => {
  it('never removes an entry before the 24-hour minimum retention has elapsed', async () => {
    await fc.assert(
      fc.asyncProperty(inputArb, async (input) => {
        const {
          resourceType,
          resourceId,
          metric,
          oldValue,
          newValue,
          oldLevel,
          newLevel,
          entryTimeMs,
          deltaMs,
        } = input;

        const entry = {
          metric,
          timestamp: new Date(entryTimeMs).toISOString(),
          oldValue,
          newValue,
          oldLevel,
          newLevel,
        };

        storedBody = JSON.stringify({
          lastLevels: { [metric]: newLevel },
          lastValues: { [metric]: newValue },
          history: [entry],
        });

        const nowMs = entryTimeMs + deltaMs;
        vi.useFakeTimers();
        vi.setSystemTime(nowMs);

        try {
          const result = await getHistory(resourceType, resourceId, metric);
          expect(result).toHaveLength(1);
          expect(result[0]).toEqual(entry);
        } finally {
          vi.useRealTimers();
        }
      }),
      { numRuns: 100 },
    );
  });
});
