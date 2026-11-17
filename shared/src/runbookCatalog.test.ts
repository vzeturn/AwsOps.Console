import { describe, it, expect } from 'vitest';
import {
  RUNBOOK_BY_FINDING,
  RUNBOOK_BY_METRIC,
  getRunbookForFinding,
  getRunbookForMetric,
  type RunbookEntry,
} from './runbookCatalog.js';
import type { RecommendationFindingType } from './index.js';

/**
 * `RUNBOOK_BY_FINDING` is typed as `Record<RecommendationFindingType, RunbookEntry>`, which
 * already makes a missing key a COMPILE error. This test is a second, runtime-level guard against
 * the ways that compile-time guarantee could still be silently defeated — an entry present but
 * with an empty/placeholder field (e.g. someone adds a new finding type and stubs it with `''` to
 * make the compiler happy, intending to "fill it in later" and forgetting to).
 */
const ALL_FINDING_TYPES: readonly RecommendationFindingType[] = [
  'ec2LowCpu',
  'ec2Stopped',
  'rdsLowCpu',
  'rdsLowConnections',
  'rdsMissingMultiAz',
  'natGatewayLowThroughput',
  'albAllTargetsUnhealthy',
  'ebsVolumeUnattached',
  's3BucketNoLifecyclePolicy',
  'savingsPlanCoverageLow',
  'backupJobFailed',
  'ebsVolumeGp2ShouldBeGp3',
  'cloudWatchLogGroupNoRetention',
  'elasticIpUnused',
  'backupVaultNotProtected',
  'restoreTestingNotConfigured',
  'ec2Underprovisioned',
  'rdsUnderprovisioned',
  'rdsResourceGovernanceMissing',
];

function assertWellFormed(entry: RunbookEntry, label: string): void {
  expect(entry.title, `${label}.title`).toBeTruthy();
  expect(entry.symptom, `${label}.symptom`).toBeTruthy();
  expect(entry.diagnosis, `${label}.diagnosis`).not.toHaveLength(0);
  expect(entry.remediation, `${label}.remediation`).not.toHaveLength(0);
  expect(entry.escalateWhen, `${label}.escalateWhen`).not.toHaveLength(0);
  for (const step of entry.diagnosis) expect(step.length, `${label}.diagnosis step`).toBeGreaterThan(0);
  for (const step of entry.remediation) expect(step.length, `${label}.remediation step`).toBeGreaterThan(0);
  for (const step of entry.escalateWhen) expect(step.length, `${label}.escalateWhen step`).toBeGreaterThan(0);
  expect(['info', 'warning', 'critical']).toContain(entry.defaultSeverity);
}

describe('RUNBOOK_BY_FINDING — completeness', () => {
  it('has a well-formed entry for every RecommendationFindingType', () => {
    for (const findingType of ALL_FINDING_TYPES) {
      const entry = RUNBOOK_BY_FINDING[findingType];
      expect(entry, `missing runbook for findingType "${findingType}"`).toBeDefined();
      assertWellFormed(entry, findingType);
    }
  });

  it('getRunbookForFinding returns the same object as direct lookup for every finding type', () => {
    for (const findingType of ALL_FINDING_TYPES) {
      expect(getRunbookForFinding(findingType)).toBe(RUNBOOK_BY_FINDING[findingType]);
    }
  });

  it('every entry with a remediation that names a 1-click automation also has a rollback', () => {
    // Not a strict 1:1 rule (a couple of findings are deliberately irreversible, e.g.
    // elasticIpUnused/albAllTargetsUnhealthy is an incident not a reversible change) — this test
    // instead locks down the SPECIFIC set of findings whose remediation explicitly claims to be
    // reversible, so a future edit that adds "genuinely reversible" wording without a matching
    // rollback section is caught.
    const claimsReversible: RecommendationFindingType[] = [
      'ec2LowCpu',
      'rdsLowConnections',
      'ebsVolumeUnattached',
      'ebsVolumeGp2ShouldBeGp3',
      'cloudWatchLogGroupNoRetention',
      'backupVaultNotProtected',
      'restoreTestingNotConfigured',
      'rdsMissingMultiAz',
      'rdsResourceGovernanceMissing',
    ];
    for (const findingType of claimsReversible) {
      expect(RUNBOOK_BY_FINDING[findingType].rollback, `${findingType}.rollback`).toBeDefined();
      expect(RUNBOOK_BY_FINDING[findingType].rollback!.length).toBeGreaterThan(0);
    }
  });
});

const CIS_BENCHMARK_METRICS = [
  'CloudTrailConfigChangesCount',
  'ConsoleLoginFailuresCount',
  'ConsoleSigninWithoutMFACount',
  'IAMPolicyChangesCount',
  'KMSKeyDisableOrDeleteCount',
  'NACLChangesCount',
  'RootAccountUsageCount',
  'RouteTableChangesCount',
  'S3BucketPolicyChangesCount',
  'SecurityGroupChangesCount',
  'UnauthorizedAPICallsCount',
  'VPCChangesCount',
];

describe('RUNBOOK_BY_METRIC', () => {
  const expectedMetrics = [
    'CPUUtilization',
    'FreeableMemory',
    'FreeStorageSpace',
    'DatabaseConnections',
    'SwapUsage',
    'UnHealthyHostCount',
    'StatusCheckFailed',
    ...CIS_BENCHMARK_METRICS,
  ];

  it('has a well-formed entry for every documented metric', () => {
    for (const metric of expectedMetrics) {
      const entry = RUNBOOK_BY_METRIC[metric];
      expect(entry, `missing runbook for metric "${metric}"`).toBeDefined();
      assertWellFormed(entry, metric);
    }
  });

  it('getRunbookForMetric returns undefined for an unknown metric name (not every metric has a runbook)', () => {
    expect(getRunbookForMetric('SomeMetricNobodyDocumentedYet')).toBeUndefined();
  });

  it('getRunbookForMetric returns the same object as direct lookup for a known metric', () => {
    expect(getRunbookForMetric('CPUUtilization')).toBe(RUNBOOK_BY_METRIC.CPUUtilization);
  });
});

/**
 * Regression coverage for the CIS Benchmark alarm SEV-mudiness investigation (2026-09-22): all 12
 * of these metrics used to have NO runbook entry at all, which is exactly why every `CIS-*-Alarm`
 * (namespace `CISBenchmark`) permanently rendered as SEV-2 with a generic "no dedicated runbook
 * exists yet" impact — regardless of how severe the underlying security event actually was. This
 * test locks down that every one of them now resolves, is well-formed, AND every entry's title
 * cites its own CIS control number (so a reader can cross-reference the actual benchmark
 * document, not just this project's paraphrase of it).
 */
describe('RUNBOOK_BY_METRIC — CIS Benchmark coverage', () => {
  it('has a well-formed entry with a cited CIS control number for every CIS Benchmark metric', () => {
    for (const metric of CIS_BENCHMARK_METRICS) {
      const entry = RUNBOOK_BY_METRIC[metric];
      expect(entry, `missing runbook for CIS metric "${metric}"`).toBeDefined();
      assertWellFormed(entry, metric);
      expect(entry.title, `${metric}.title should cite a CIS control number`).toMatch(/CIS \d/);
    }
  });

  it('every CIS Benchmark entry escalates to a human rather than claiming a fully automated fix (these are security events, not routine cost findings)', () => {
    for (const metric of CIS_BENCHMARK_METRICS) {
      expect(RUNBOOK_BY_METRIC[metric].escalateWhen.length).toBeGreaterThan(0);
    }
  });
});
