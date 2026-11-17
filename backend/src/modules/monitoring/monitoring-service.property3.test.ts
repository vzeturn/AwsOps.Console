import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';

// Feature: realtime-monitoring-dashboard, Property 3: CWAgent metric visibility depends only on current freshness
//
// For any EC2 instance and any two independent refresh cycles with different CWAgent data
// availability (present-and-fresh vs. absent-or-stale), mem_used_percent/disk_used_percent SHALL
// appear in that instance's metric set if and only if the current cycle's data is present and
// fresh (datapoint timestamp within 5 minutes), regardless of the outcome of any previous cycle.
//
// The hide/show decision itself lives in the private, unexported `buildCwAgentRealtimeMetricIfFresh()`
// helper inside `getMonitoringData()`. This test exercises the exported pure function that IS the
// freshness gate the property describes: `isCwAgentDatapointFresh(timestamp, now)`.
//
// Validates: Requirements 2.1, 2.2, 2.3, 2.4

// monitoring-service.ts reads the region directly from process.env.AWS_REGION at module scope —
// set it before importing (same as monitoring-service.property1.test.ts/monitoring-service.test.ts).
process.env.AWS_REGION = 'ap-southeast-1';
// monitoring-service.ts (Task 3.10) statically imports `threshold-history-service.ts`, which
// throws at module scope if ASSESSMENT_BUCKET_NAME is missing — set it before importing, even
// though this test doesn't call recordIfChanged/getHistory.
process.env.ASSESSMENT_BUCKET_NAME = 'test-assessment-bucket';

// monitoring-service.ts statically imports `loadAlb` from infra-service.ts, which creates an AWS
// SDK client at module scope reading `config.awsRegion` (readRequiredEnv throws if the env var is
// missing) — mock config.js following the same pattern as
// router.test.ts/assessment-service.test.ts/monitoring-service.property1 so the import doesn't
// throw. This test never calls loadAlb/AWS APIs — it just needs the import chain to resolve.
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
const { isCwAgentDatapointFresh } = await import('./monitoring-service.js');

const FIVE_MINUTES_MS = 5 * 60 * 1000;

/** Generates (timestamp, now) pairs spanning the 5-minute boundary in both directions, including
 * exactly at the boundary, by generating an arbitrary `now` moment and an offset (which may be
 * negative/positive) added to it to derive `timestamp`. The offset is bounded to [-10 min, +10 min]
 * around the 5-minute mark to concentrate case generation near the boundary (enough to cover
 * before/after/exactly-at) while still having a wider range via fc.integer. */
const timestampNowPairArb = fc
  .record({
    nowMs: fc.integer({ min: 0, max: 2_000_000_000_000 }),
    // offsetMs = now - timestamp. A wide range that always includes exactly FIVE_MINUTES_MS.
    offsetMs: fc.integer({ min: -20 * 60 * 1000, max: 20 * 60 * 1000 }),
  })
  .map(({ nowMs, offsetMs }) => ({
    now: new Date(nowMs),
    timestamp: new Date(nowMs - offsetMs),
  }));

describe('Property 3: CWAgent metric visibility depends only on current freshness', () => {
  it('isCwAgentDatapointFresh(timestamp, now) is true iff now - timestamp <= 5 minutes, and is stateless across calls', () => {
    fc.assert(
      fc.property(timestampNowPairArb, ({ timestamp, now }) => {
        const diffMs = now.getTime() - timestamp.getTime();
        const expected = diffMs <= FIVE_MINUTES_MS;

        expect(isCwAgentDatapointFresh(timestamp, now)).toBe(expected);
      }),
      { numRuns: 200 },
    );
  });

  it('exactly at the 5-minute boundary the datapoint is fresh (still visible)', () => {
    const now = new Date('2024-01-01T00:05:00.000Z');
    const timestamp = new Date('2024-01-01T00:00:00.000Z'); // exactly 5 minutes before now.
    expect(isCwAgentDatapointFresh(timestamp, now)).toBe(true);
  });

  it('is stateless: calling with the same (timestamp, now) pair between calls with different inputs yields identical results both times', () => {
    fc.assert(
      fc.property(
        timestampNowPairArb,
        timestampNowPairArb,
        (pairA, pairB) => {
          // Call A, then B (different input), then A again — the 2 A results must be identical,
          // proving the function doesn't depend on the B call in between (statelessness).
          const resultA1 = isCwAgentDatapointFresh(pairA.timestamp, pairA.now);
          const resultB = isCwAgentDatapointFresh(pairB.timestamp, pairB.now);
          const resultA2 = isCwAgentDatapointFresh(pairA.timestamp, pairA.now);

          expect(resultA2).toBe(resultA1);

          // resultB is computed independently, reusing the same expected formula to make sure
          // there's no state leaking between 2 different input pairs.
          expect(resultB).toBe(pairB.now.getTime() - pairB.timestamp.getTime() <= FIVE_MINUTES_MS);
        },
      ),
      { numRuns: 150 },
    );
  });

  it('just over the 5-minute boundary the datapoint is stale (hidden)', () => {
    const now = new Date('2024-01-01T00:05:00.001Z');
    const timestamp = new Date('2024-01-01T00:00:00.000Z'); // 5 minutes + 1ms before now.
    expect(isCwAgentDatapointFresh(timestamp, now)).toBe(false);
  });
});
