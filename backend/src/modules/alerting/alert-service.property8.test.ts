import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';

// Feature: realtime-monitoring-dashboard, Property 8: Alert grouping puts critical first
//
// For any list of AlarmSummary with arbitrary Threshold_Level values, the ordered list produced
// for Alert_View SHALL place every entry with level critical before every entry with level warn
// or ok.
//
// Validates: Requirements 9.2

// alert-service.ts reads region directly from process.env.AWS_REGION at module scope (same
// pattern as monitoring-service.ts) — set before import.
process.env.AWS_REGION = 'ap-southeast-1';
// alert-service.ts imports `buildConsoleLink` from monitoring-service.ts, which imports
// threshold-history-service.ts — that module throws at module scope if ASSESSMENT_BUCKET_NAME is
// missing — set before import even though this test never calls recordIfChanged/getHistory.
process.env.ASSESSMENT_BUCKET_NAME = 'test-assessment-bucket';

// monitoring-service.ts (transitively imported by alert-service.ts) imports `loadAlb` from
// infra-service.ts, which imports config.ts (module singleton that throws if any required env var
// is missing) at module scope. Mock config.js so the import chain resolves, following the exact
// pattern used in monitoring-service.property1/2.test.ts.
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

const cloudwatchSendMock = vi.fn();
const ec2SendMock = vi.fn();
const rdsSendMock = vi.fn();
const elbSendMock = vi.fn();

vi.mock('@aws-sdk/client-cloudwatch', () => ({
  CloudWatchClient: vi.fn().mockImplementation(() => ({ send: cloudwatchSendMock })),
  DescribeAlarmsCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'DescribeAlarms', input })),
  GetMetricDataCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
  ListMetricsCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
}));

// infra-service.ts (transitively imported) creates EC2Client/RDSClient/ElasticLoadBalancingV2Client
// at module scope — not exercised by this property, but required for the import chain to resolve
// without constructing real AWS SDK clients.
vi.mock('@aws-sdk/client-ec2', () => ({
  EC2Client: vi.fn().mockImplementation(() => ({ send: ec2SendMock })),
  DescribeInstancesCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
  DescribeVolumesCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
}));

vi.mock('@aws-sdk/client-rds', () => ({
  RDSClient: vi.fn().mockImplementation(() => ({ send: rdsSendMock })),
  DescribeDBInstancesCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
}));

vi.mock('@aws-sdk/client-elastic-load-balancing-v2', () => ({
  ElasticLoadBalancingV2Client: vi.fn().mockImplementation(() => ({ send: elbSendMock })),
  DescribeLoadBalancersCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
  DescribeTargetGroupsCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
  DescribeTargetHealthCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
}));

// Import after mocks are declared (vi.mock is hoisted by vitest).
const { getAlerts } = await import('./alert-service.js');

beforeEach(() => {
  cloudwatchSendMock.mockReset();
});

// ---- Arbitraries ----

const ALARM_STATE_VALUES = ['OK', 'ALARM', 'INSUFFICIENT_DATA'] as const;

/** AlarmName is always present (required for `toAlarmSummary` to keep the alarm) — StateValue is
 * arbitrary across the 3 known values, which map to ok/critical/warn respectively. */
const alarmArb = fc.record({
  state: fc.constantFrom(...ALARM_STATE_VALUES),
});

const alarmsArb = fc.array(alarmArb, { minLength: 0, maxLength: 30 });

function mockDescribeAlarms(alarms: { state: (typeof ALARM_STATE_VALUES)[number] }[]) {
  return {
    MetricAlarms: alarms.map((alarm, idx) => ({
      AlarmName: `alarm-${idx}`,
      StateValue: alarm.state,
      Namespace: 'AWS/EC2',
    })),
  };
}

const LEVEL_BY_STATE: Record<(typeof ALARM_STATE_VALUES)[number], 'critical' | 'warn' | 'ok'> = {
  ALARM: 'critical',
  INSUFFICIENT_DATA: 'warn',
  OK: 'ok',
};

describe('Alert grouping puts critical first (Property 8)', () => {
  it('every critical entry precedes every warn/ok entry in the ordered list', async () => {
    await fc.assert(
      fc.asyncProperty(alarmsArb, async (alarms) => {
        cloudwatchSendMock.mockImplementation(async () => mockDescribeAlarms(alarms));

        const result = await getAlerts();

        const criticalIndices: number[] = [];
        const nonCriticalIndices: number[] = [];
        result.forEach((summary, idx) => {
          if (summary.threshold.level === 'critical') criticalIndices.push(idx);
          else nonCriticalIndices.push(idx);
        });

        const maxCriticalIndex = criticalIndices.length > 0 ? Math.max(...criticalIndices) : -1;
        const minNonCriticalIndex = nonCriticalIndices.length > 0 ? Math.min(...nonCriticalIndices) : Infinity;

        expect(maxCriticalIndex).toBeLessThan(minNonCriticalIndex);

        // Sanity: every alarm survives (none dropped), and level mapping matches Property 7's rule.
        expect(result).toHaveLength(alarms.length);
        const expectedLevelCounts = alarms.reduce(
          (acc, alarm) => {
            acc[LEVEL_BY_STATE[alarm.state]]++;
            return acc;
          },
          { critical: 0, warn: 0, ok: 0 },
        );
        const actualLevelCounts = result.reduce(
          (acc, summary) => {
            acc[summary.threshold.level]++;
            return acc;
          },
          { critical: 0, warn: 0, ok: 0 },
        );
        expect(actualLevelCounts).toEqual(expectedLevelCounts);
      }),
      { numRuns: 100 },
    );
  });
});
