import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';
import type { MonitoringResourceType, ThresholdHistoryEntry, ThresholdLevel } from '@ops-dashboard/shared';

// Task 6.3: property test for threshold-history-service.ts (Property 13).
// The module reads process.env.ASSESSMENT_BUCKET_NAME/AWS_REGION right at module scope
// (fail-loud if missing) — set them before importing, following the same pattern as
// infra-review-collector.test.ts.
process.env.AWS_REGION = 'ap-southeast-1';
process.env.ASSESSMENT_BUCKET_NAME = 'test-assessment-bucket';

const s3SendMock = vi.fn();

// GetObjectCommand/PutObjectCommand are mocked as objects carrying __type so s3SendMock can tell
// them apart (same pattern as storage-collector.test.ts/assessment-service.test.ts).
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: s3SendMock })),
  GetObjectCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'GetObject', input })),
  PutObjectCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'PutObject', input })),
}));

// Import after the mocks/env are declared (vi.mock is hoisted to the top by vitest).
const { getHistory } = await import('./threshold-history-service.js');

// Feature: realtime-monitoring-dashboard, Property 13: Threshold_History retrieval returns exactly the retained window
//
// For any set of stored ThresholdHistoryEntry records for a resource/metric and any query, the
// entries returned by getHistory SHALL be exactly those still within the retention window (not yet
// pruned), with no entries fabricated or omitted.
//
// Validates: Requirements 14.3

const RETENTION_MS = 24 * 60 * 60 * 1000;
// Safety margin around the 24h boundary: getHistory() calls Date.now() a second time
// (independent of the nowMs the test uses to compute "expected"), so timestamps too close to the
// boundary must be avoided to keep the test from flaking due to a few ms passing between the test
// building the timestamp and getHistory() actually running.
const MARGIN_MS = 60_000;

const METRIC_POOL = ['CPUUtilization', 'FreeableMemory', 'StatusCheckFailed', 'mem_used_percent', 'VolumeQueueLength'] as const;

const thresholdLevelArb: fc.Arbitrary<ThresholdLevel> = fc.constantFrom('ok', 'warn', 'critical');
const resourceTypeArb: fc.Arbitrary<MonitoringResourceType> = fc.constantFrom('ec2', 'rds', 'alb', 'ebs');

/** offsetMs from when the generator runs: either clearly still within the 24h retention window,
 * or clearly expired — never generates a value close to the RETENTION_MS boundary (see
 * MARGIN_MS). */
const offsetMsArb = fc.oneof(
  fc.integer({ min: 0, max: RETENTION_MS - MARGIN_MS }),
  fc.integer({ min: RETENTION_MS + MARGIN_MS, max: RETENTION_MS + 7 * 24 * 60 * 60 * 1000 }),
);

const storedEntrySpecArb = fc.record({
  metric: fc.constantFrom(...METRIC_POOL),
  offsetMs: offsetMsArb,
  oldValue: fc.integer({ min: -1000, max: 1000 }),
  newValue: fc.integer({ min: -1000, max: 1000 }),
  oldLevel: thresholdLevelArb,
  newLevel: thresholdLevelArb,
});

beforeEach(() => {
  s3SendMock.mockReset();
});

describe('getHistory (Property 13)', () => {
  it('returns exactly the right subset: metric matches the query AND is still within the 24h retention window — nothing missing, nothing extra', async () => {
    await fc.assert(
      fc.asyncProperty(
        resourceTypeArb,
        fc.string({ minLength: 1, maxLength: 20 }),
        fc.constantFrom(...METRIC_POOL),
        fc.array(storedEntrySpecArb, { maxLength: 30 }),
        async (resourceType, resourceId, targetMetric, storedSpecs) => {
          const storedEntries: ThresholdHistoryEntry[] = storedSpecs.map((spec) => ({
            metric: spec.metric,
            timestamp: new Date(Date.now() - spec.offsetMs).toISOString(),
            oldValue: spec.oldValue,
            newValue: spec.newValue,
            oldLevel: spec.oldLevel,
            newLevel: spec.newLevel,
          }));

          const nowMs = Date.now();
          const expected = storedEntries.filter(
            (entry) => entry.metric === targetMetric && nowMs - new Date(entry.timestamp).getTime() < RETENTION_MS,
          );

          s3SendMock.mockImplementation(async () => ({
            Body: {
              transformToString: async () =>
                JSON.stringify({ lastLevels: {}, lastValues: {}, history: storedEntries }),
            },
          }));

          const result = await getHistory(resourceType, resourceId, targetMetric);

          expect(result).toEqual(expected);
        },
      ),
      { numRuns: 100 },
    );
  });
});
