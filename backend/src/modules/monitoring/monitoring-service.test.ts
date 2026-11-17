import { describe, it, expect, vi, beforeEach } from 'vitest';

// Task 2.8: unit test for `evalMonitoringThreshold()` — the `RDS_INSTANCE_RAM_GIB` lookup-miss
// case (Design Error Handling: a DBInstanceClass not present in the lookup table -> FreeableMemory/
// SwapUsage fall back to measured-only, does NOT throw).
//
// Requirements: 4.2, 4.5

// monitoring-service.ts reads the region directly from process.env.AWS_REGION at module scope —
// set it before importing (same as monitoring-service.property1.test.ts).
process.env.AWS_REGION = 'ap-southeast-1';
// monitoring-service.ts (Task 3.10) statically imports `threshold-history-service.ts`, which
// throws at module scope if ASSESSMENT_BUCKET_NAME is missing — set it before importing, even
// though this test doesn't call recordIfChanged/getHistory.
process.env.ASSESSMENT_BUCKET_NAME = 'test-assessment-bucket';

// monitoring-service.ts statically imports `loadAlb` from infra-service.ts, which creates an AWS
// SDK client at module scope reading `config.awsRegion` (readRequiredEnv throws if the env var is
// missing) — mock config.js following the same pattern as router.test.ts/assessment-service.test.ts
// so the import doesn't throw.
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

const ec2SendMock = vi.fn();

vi.mock('@aws-sdk/client-ec2', () => ({
  EC2Client: vi.fn().mockImplementation(() => ({ send: ec2SendMock })),
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
const { evalMonitoringThreshold, isCwAgentDatapointFresh, buildConsoleLink, parseConsoleLink, loadOnlineEc2 } = await import(
  './monitoring-service.js'
);

const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

beforeEach(() => {
  consoleWarnSpy.mockClear();
});

describe('evalMonitoringThreshold — RDS_INSTANCE_RAM_GIB lookup miss fallback (Task 2.8)', () => {
  it('FreeableMemory with a DBInstanceClass not in the lookup table → returns undefined, does not throw', () => {
    expect(() =>
      evalMonitoringThreshold('rds', 'FreeableMemory', 1000000, { dbInstanceClass: 'db.unknown.class' }),
    ).not.toThrow();

    const result = evalMonitoringThreshold('rds', 'FreeableMemory', 1000000, {
      dbInstanceClass: 'db.unknown.class',
    });
    expect(result).toBeUndefined();
  });

  it('SwapUsage with a DBInstanceClass not in the lookup table → returns undefined, does not throw', () => {
    expect(() =>
      evalMonitoringThreshold('rds', 'SwapUsage', 1000000, { dbInstanceClass: 'db.unknown.class' }),
    ).not.toThrow();

    const result = evalMonitoringThreshold('rds', 'SwapUsage', 1000000, {
      dbInstanceClass: 'db.unknown.class',
    });
    expect(result).toBeUndefined();
  });

  it('FreeableMemory/SwapUsage with context.dbInstanceClass not passed at all (undefined) → still does not throw, returns undefined', () => {
    expect(() => evalMonitoringThreshold('rds', 'FreeableMemory', 1000000, {})).not.toThrow();
    expect(() => evalMonitoringThreshold('rds', 'SwapUsage', 1000000, {})).not.toThrow();

    expect(evalMonitoringThreshold('rds', 'FreeableMemory', 1000000, {})).toBeUndefined();
    expect(evalMonitoringThreshold('rds', 'SwapUsage', 1000000, {})).toBeUndefined();
  });
});

// Task 3.3: unit test for `isCwAgentDatapointFresh()` — the exact 5-minute boundary (300,000ms).
// The corresponding property test (Property 3, monitoring-service.property3.test.ts, Task 3.2)
// already covers the general boundary behavior with fast-check — the 2 concrete examples below
// serve as clear documentation/regression, matching the exact `<=` comparison in the function's
// actual implementation.
//
// Requirements: 2.2, 2.3

describe('isCwAgentDatapointFresh — the 5-minute boundary (Task 3.3)', () => {
  it('a datapoint exactly 5 minutes old (300,000ms) → still fresh/visible (true)', () => {
    const timestamp = new Date('2024-01-01T00:00:00.000Z');
    const now = new Date('2024-01-01T00:05:00.000Z');

    expect(isCwAgentDatapointFresh(timestamp, now)).toBe(true);
  });

  it('a datapoint more than 5 minutes old (300,001ms) → stale/hidden (false)', () => {
    const timestamp = new Date('2024-01-01T00:00:00.000Z');
    const now = new Date('2024-01-01T00:05:00.001Z');

    expect(isCwAgentDatapointFresh(timestamp, now)).toBe(false);
  });
});

// Task 3.7: unit test for `buildConsoleLink()` — 1 concrete example with a real dimension
// `InstanceId=i-xxx`, matching design.md's Testing Strategy description ("buildConsoleLink/reverse
// parser: 1-2 concrete examples with a real dimension (InstanceId=i-xxx)").
//
// Requirements: 12.2

describe('buildConsoleLink — a concrete example with a real InstanceId (Task 3.7)', () => {
  it('builds the correct CloudWatch Console URL for CPUUtilization of an EC2 instance in ap-southeast-1', () => {
    const url = buildConsoleLink({
      region: 'ap-southeast-1',
      namespace: 'AWS/EC2',
      metricName: 'CPUUtilization',
      dimensionName: 'InstanceId',
      dimensionValue: 'i-0abc123def456',
    });

    // Sanity-check the URL structure: correct CloudWatch Console host, correct region in the query
    // string — these 2 parts are required for the browser to navigate to the right service/region
    // before it even reads the hash.
    expect(url.startsWith('https://ap-southeast-1.console.aws.amazon.com/cloudwatch/home?region=ap-southeast-1')).toBe(
      true,
    );

    // Namespace/metricName/dimensionName/dimensionValue must appear (encoded) in the hash, in the
    // order specified by design.md's scheme.
    expect(url).toContain(encodeURIComponent('AWS/EC2'));
    expect(url).toContain('CPUUtilization');
    expect(url).toContain('InstanceId');
    expect(url).toContain('i-0abc123def456');

    // A stronger assertion: the URL round-trips correctly through the reverse parser, meaning
    // opening this URL in a browser will point to the correct namespace/metricName/dimension/region
    // graph — not just "contains a substring".
    expect(parseConsoleLink(url)).toEqual({
      region: 'ap-southeast-1',
      namespace: 'AWS/EC2',
      metricName: 'CPUUtilization',
      dimensionName: 'InstanceId',
      dimensionValue: 'i-0abc123def456',
    });
  });
});

describe('loadOnlineEc2 — pagination (Task 2)', () => {
  it('merges online EC2 results across multiple pages when DescribeInstances returns a NextToken', async () => {
    ec2SendMock
      .mockResolvedValueOnce({
        Reservations: [
          { Instances: [{ InstanceId: 'i-page1', InstanceType: 't3.micro', State: { Name: 'running' }, Tags: [] }] },
        ],
        NextToken: 'token-page-2',
      })
      .mockResolvedValueOnce({
        Reservations: [
          { Instances: [{ InstanceId: 'i-page2', InstanceType: 't3.small', State: { Name: 'running' }, Tags: [] }] },
        ],
      });

    const result = await loadOnlineEc2();

    expect(result.map((i) => i.instanceId)).toEqual(['i-page1', 'i-page2']);
    expect(ec2SendMock).toHaveBeenCalledTimes(2);
  });
});
