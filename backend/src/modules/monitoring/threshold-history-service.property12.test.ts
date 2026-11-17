import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';
import type { MonitoringResourceType, ThresholdLevel } from '@ops-dashboard/shared';

// Feature: realtime-monitoring-dashboard, Property 12: Threshold_History records exactly on level change
//
// For any pair of consecutive threshold evaluations (oldValue, oldLevel) and (newValue, newLevel) for
// the same resource/metric, a new ThresholdHistoryEntry SHALL be appended if and only if
// oldLevel !== newLevel, and when appended its fields SHALL exactly equal the given old/new
// value/level pair with the current timestamp.
//
// Validates: Requirements 14.1
//
// Note on the very first-ever evaluation: `recordIfChanged()` (Task 6.1) seeds the baseline
// (`lastLevels`/`lastValues`) from an empty store without fabricating a "change" entry, since there
// is no real prior value/level to report (see threshold-history-service.ts, `hadPriorEvaluation`).
// This property therefore always calls `recordIfChanged()` once first (to establish `oldLevel`) and
// then asserts the behavior of the *second* call (the actual old->new transition under test).

process.env.AWS_REGION = 'ap-southeast-1';
process.env.ASSESSMENT_BUCKET_NAME = 'test-assessment-bucket';

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

const { recordIfChanged } = await import('./threshold-history-service.js');

beforeEach(() => {
  storedBody = undefined;
  s3SendMock.mockClear();
});

const levelArb: fc.Arbitrary<ThresholdLevel> = fc.constantFrom('ok', 'warn', 'critical');
const resourceTypeArb: fc.Arbitrary<MonitoringResourceType> = fc.constantFrom('ec2', 'rds', 'alb', 'ebs');
// Exclude -0: JSON.stringify serializes -0 as "0", which would make a strict equality
// comparison against the original entry spuriously fail (a JSON round-trip artifact, not a
// real behavioral bug).
const valueArb = fc
  .float({ min: -1_000_000, max: 1_000_000, noNaN: true })
  .filter((v) => !Object.is(v, -0));

const inputArb = fc.record({
  resourceType: resourceTypeArb,
  resourceId: fc.string({ minLength: 1 }).filter((s) => s.trim().length > 0),
  metric: fc.string({ minLength: 1 }).filter((s) => s.trim().length > 0),
  oldValue: valueArb,
  oldLevel: levelArb,
  newValue: valueArb,
  newLevel: levelArb,
});

describe('recordIfChanged (Property 12)', () => {
  it('appends a ThresholdHistoryEntry iff oldLevel !== newLevel, with fields matching exactly', async () => {
    await fc.assert(
      fc.asyncProperty(inputArb, async (input) => {
        // Reset the mocked S3 "store" for each generated case (fast-check runs many cases against
        // the same describe/it, so state must not leak between them).
        storedBody = undefined;

        const { resourceType, resourceId, metric, oldValue, oldLevel, newValue, newLevel } = input;

        // First call: seeds the baseline (oldLevel) - no history entry expected regardless of level,
        // since there is no prior evaluation at all yet.
        await recordIfChanged(resourceType, resourceId, metric, oldValue, oldLevel);

        const beforeSecondCall = storedBody;

        // Second call: the actual old -> new transition under test.
        await recordIfChanged(resourceType, resourceId, metric, newValue, newLevel);

        if (oldLevel === newLevel) {
          // No change -> no PUT at all on the second call -> stored body unchanged.
          expect(storedBody).toBe(beforeSecondCall);
        } else {
          expect(storedBody).not.toBeUndefined();
          const store = JSON.parse(storedBody!) as {
            lastLevels: Record<string, ThresholdLevel>;
            lastValues: Record<string, number>;
            history: Array<{
              metric: string;
              timestamp: string;
              oldValue: number;
              newValue: number;
              oldLevel: ThresholdLevel;
              newLevel: ThresholdLevel;
            }>;
          };

          const entriesForMetric = store.history.filter((e) => e.metric === metric);
          expect(entriesForMetric).toHaveLength(1);

          const entry = entriesForMetric[0];
          expect(entry.oldValue).toBe(oldValue);
          expect(entry.newValue).toBe(newValue);
          expect(entry.oldLevel).toBe(oldLevel);
          expect(entry.newLevel).toBe(newLevel);
          expect(typeof entry.timestamp).toBe('string');
          expect(new Date(entry.timestamp).toString()).not.toBe('Invalid Date');

          // lastLevels/lastValues reflect the latest evaluation.
          expect(store.lastLevels[metric]).toBe(newLevel);
          expect(store.lastValues[metric]).toBe(newValue);
        }
      }),
      { numRuns: 100 },
    );
  });
});
