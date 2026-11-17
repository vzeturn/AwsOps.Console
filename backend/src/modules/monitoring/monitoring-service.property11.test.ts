import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';

// Feature: realtime-monitoring-dashboard, Property 11: Metric_Trend window bounds
//
// For any series of raw CloudWatch datapoints (with arbitrary timestamps) and any "current time",
// every point in the Metric_Trend produced SHALL have a timestamp within 60 minutes before the
// current time, the trend SHALL never include a point with a timestamp after the current time, and
// points SHALL be in non-decreasing chronological order.
//
// Validates: Requirements 13.1

// monitoring-service.ts reads the region directly from process.env.AWS_REGION at module scope —
// set it before importing (same as the other monitoring-service.propertyN.test.ts files).
process.env.AWS_REGION = 'ap-southeast-1';
// monitoring-service.ts (Task 3.10) statically imports `threshold-history-service.ts`, which
// throws at module scope if ASSESSMENT_BUCKET_NAME is missing — set it before importing, even
// though this test doesn't call recordIfChanged/getHistory.
process.env.ASSESSMENT_BUCKET_NAME = 'test-assessment-bucket';

// monitoring-service.ts statically imports `loadAlb` from infra-service.ts, which creates an AWS
// SDK client at module scope reading `config.awsRegion` (readRequiredEnv throws if the env var is
// missing) — mock config.js following the same pattern as router.test.ts/monitoring-service.property2/
// property6 tests so the import doesn't throw. This test never calls loadAlb/AWS APIs — it just
// needs the import chain to resolve.
vi.mock('../../config.js', () => ({
  config: {
    allowedOrigins: [],
    entraTenantId: 'test-tenant',
    entraClientId: 'test-client',
    allowedGroupIds: [],
    awsRegion: 'ap-southeast-1',
    costCacheParamName: 'test-cost-cache-param',
    assessmentBucketName: 'test-assessment-bucket',
  },
  corsHeaders: () => ({}),
}));

vi.mock('@aws-sdk/client-ec2', () => ({
  EC2Client: vi.fn().mockImplementation(() => ({ send: vi.fn() })),
  DescribeInstancesCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
  DescribeVolumesCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
}));

vi.mock('@aws-sdk/client-rds', () => ({
  RDSClient: vi.fn().mockImplementation(() => ({ send: vi.fn() })),
  DescribeDBInstancesCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
}));

// infra-service.ts (imported by monitoring-service.ts) creates an ElasticLoadBalancingV2Client at
// module scope — unused in this test, but must be mocked so importing monitoring-service.js
// doesn't construct a real client.
vi.mock('@aws-sdk/client-elastic-load-balancing-v2', () => ({
  ElasticLoadBalancingV2Client: vi.fn().mockImplementation(() => ({ send: vi.fn() })),
  DescribeLoadBalancersCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
  DescribeTargetGroupsCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
  DescribeTargetHealthCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
}));

// Import after the mocks are declared (vi.mock is hoisted to the top by vitest).
const { buildMetricTrend } = await import('./monitoring-service.js');

const ONE_MINUTE_MS = 60 * 1000;
const WINDOW_MS = 60 * ONE_MINUTE_MS; // 60 minutes — matches METRIC_TREND_WINDOW_MS in monitoring-service.ts.

/** An arbitrary `now` — a wide epoch range, not restricted around "the real current time", to cover more scenarios. */
const nowArb = fc.integer({ min: 0, max: 4_000_000_000_000 }).map((ms) => new Date(ms));

/**
 * A datapoint's offset (ms) relative to `now`, spanning from well before to well after, INCLUDING
 * exactly the 60-minute boundary (`-WINDOW_MS`) and points past the future/past boundary.
 */
const offsetMsArb = fc.oneof(
  fc.constant(-WINDOW_MS), // exactly the lower boundary — must still be kept (>= now - 60min).
  fc.constant(-WINDOW_MS - 1), // just past the lower boundary — must be excluded.
  fc.constant(0), // exactly now.
  fc.integer({ min: -WINDOW_MS * 3, max: WINDOW_MS * 3 }), // an arbitrary spread across past/future.
);

const datapointArb = fc.record({
  offsetMs: offsetMsArb,
  value: fc.double({ min: -1e6, max: 1e6, noNaN: true }),
});

const datapointsArb = fc.array(datapointArb, { minLength: 0, maxLength: 50 });

describe('buildMetricTrend — Metric_Trend window bounds (Property 11)', () => {
  it('every returned point is within (now - 60min, now], and points are in non-decreasing chronological order', () => {
    fc.assert(
      fc.property(datapointsArb, nowArb, (rawOffsets, now) => {
        const datapoints = rawOffsets.map(({ offsetMs, value }) => ({
          timestamp: new Date(now.getTime() + offsetMs),
          value,
        }));

        const trend = buildMetricTrend(datapoints, now);

        const nowMs = now.getTime();
        const windowStartMs = nowMs - WINDOW_MS;

        let previousMs: number | undefined;
        for (const point of trend) {
          const pointMs = new Date(point.timestamp).getTime();

          // Never in the future relative to now.
          expect(pointMs).toBeLessThanOrEqual(nowMs);
          // Never more than 60 minutes before now.
          expect(pointMs).toBeGreaterThanOrEqual(windowStartMs);

          // Chronological order is non-decreasing.
          if (previousMs !== undefined) {
            expect(pointMs).toBeGreaterThanOrEqual(previousMs);
          }
          previousMs = pointMs;
        }
      }),
      { numRuns: 100 },
    );
  });
});
