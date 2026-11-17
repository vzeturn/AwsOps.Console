import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import { evalThreshold } from '../ec2-management/index.js';

// Feature: realtime-monitoring-dashboard, Property 6: ALB threshold reuses existing evalThreshold unchanged
//
// For any pair (unhealthyTargets, totalTargets) with 0 <= unhealthyTargets <= totalTargets, the
// Threshold_Level produced for UnHealthyHostCount in the new monitoring service SHALL equal the
// result of calling the existing, unmodified evalThreshold from infra-service.ts's ALB logic with
// the same inputs.
//
// Validates: Requirements 5.2, 5.3

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
const { evalMonitoringThreshold } = await import('./monitoring-service.js');

/** Generates (totalTargets, unhealthyTargets) with 0 <= unhealthyTargets <= totalTargets — generate
 * totalTargets first, then bound unhealthyTargets within that range. */
const totalAndUnhealthyArb = fc
  .integer({ min: 0, max: 1000 })
  .chain((totalTargets) =>
    fc.integer({ min: 0, max: totalTargets }).map((unhealthyTargets) => ({ totalTargets, unhealthyTargets })),
  );

describe('evalMonitoringThreshold — alb.UnHealthyHostCount (Property 6)', () => {
  it("produces exactly the same ThresholdMeta as calling evalThreshold with loadAlb()'s exact params", () => {
    fc.assert(
      fc.property(totalAndUnhealthyArb, ({ unhealthyTargets, totalTargets }) => {
        const actual = evalMonitoringThreshold('alb', 'UnHealthyHostCount', unhealthyTargets, { totalTargets });

        // Params matching exactly what `loadAlb()` in infra-service.ts passes into evalThreshold.
        const expected = evalThreshold(unhealthyTargets, {
          warnAt: 1,
          criticalAt: totalTargets,
          direction: 'above',
          okReason: 'All targets healthy',
          warnReason: `${unhealthyTargets}/${totalTargets} targets unhealthy`,
          criticalReason: 'All targets unhealthy',
        });

        expect(actual).toEqual(expected);
      }),
      { numRuns: 100 },
    );
  });
});
