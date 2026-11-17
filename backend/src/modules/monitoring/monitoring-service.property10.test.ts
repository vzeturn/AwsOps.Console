import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';

// Feature: realtime-monitoring-dashboard, Property 10: CloudWatch_Console_Link parameter round-trip
//
// For any (region, namespace, metricName, dimensionName, dimensionValue) tuple, parsing the query
// parameters back out of the URL produced by buildConsoleLink SHALL yield exactly the same tuple
// that was passed in.
//
// Validates: Requirements 12.2, 12.3, 9.3

// monitoring-service.ts reads the region directly from process.env.AWS_REGION at module scope —
// set it before importing (same as the other monitoring-service.propertyN.test.ts files).
process.env.AWS_REGION = 'ap-southeast-1';
// monitoring-service.ts (Task 3.10) statically imports `threshold-history-service.ts`, which
// throws at module scope if ASSESSMENT_BUCKET_NAME is missing — set it before importing, even
// though this test doesn't call recordIfChanged/getHistory.
process.env.ASSESSMENT_BUCKET_NAME = 'test-assessment-bucket';

// monitoring-service.ts statically imports `loadAlb` from infra-service.ts, which creates an AWS
// SDK client at module scope reading `config.awsRegion` — mock config.js following the same
// pattern as the other monitoring-service.propertyN.test.ts files so the import doesn't throw.
// This test never calls loadAlb/AWS APIs — it just needs the import chain to resolve.
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
const { buildConsoleLink, parseConsoleLink } = await import('./monitoring-service.js');

// ---- Arbitraries ----

/** "Realistic" characters commonly found in AWS region/namespace/metric name/dimension values
 * (letters, digits, `-`, `_`, `.`, `:`, `/`) — e.g. `ap-southeast-1`, `AWS/EC2`, `CPUUtilization`,
 * `InstanceId`, `i-0abc`. */
const AWS_LIKE_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.:/'.split('');
const realisticStringArb = fc
  .array(fc.constantFrom(...AWS_LIKE_CHARS), { minLength: 1, maxLength: 20 })
  .map((chars) => chars.join(''));

/** Edge-case characters that could interact badly with the URL scheme's fixed string marker (`~'`),
 * which are NOT escaped by `encodeURIComponent` (both `~` and `'` are in `encodeURIComponent`'s
 * unencoded character set) — mixes `~`/`'` densely to raise the chance fast-check generates the
 * exact `~'` substring inside a parameter, matching the edge scenario this task requires testing. */
const edgeCaseStringArb = fc
  .array(fc.constantFrom('~', "'", ':', '/', ' ', '+', '-', '_', 'i', '0'), { minLength: 1, maxLength: 20 })
  .map((chars) => chars.join(''));

/** Any arbitrary string (full unicode) — covers cases outside the 2 groups above. */
const arbitraryStringArb = fc.string({ minLength: 1, maxLength: 20 });

const paramStringArb = fc.oneof(realisticStringArb, edgeCaseStringArb, arbitraryStringArb);

const consoleLinkParamsArb = fc.record({
  region: paramStringArb,
  namespace: paramStringArb,
  metricName: paramStringArb,
  dimensionName: paramStringArb,
  dimensionValue: paramStringArb,
});

describe('CloudWatch_Console_Link parameter round-trip (Property 10)', () => {
  it('parseConsoleLink(buildConsoleLink(params)) yields exactly the same params', () => {
    fc.assert(
      fc.property(consoleLinkParamsArb, (params) => {
        const url = buildConsoleLink(params);
        const parsed = parseConsoleLink(url);
        expect(parsed).toEqual(params);
      }),
      { numRuns: 200 },
    );
  });
});
