import { describe, it, expect } from 'vitest';
import type { RecommendationItem } from '@ops-dashboard/shared';
import {
  buildMonthlyCostSummaries,
  computeTopServiceMovers,
  findNewHighPriorityFindings,
  isNewFinding,
  sumEstimatedMonthlySavings,
  type RawMonthlyCostEntry,
} from './costReporting.js';

// Task 9: dedicated tests for the PURE functions in costReporting.ts — previously only tested
// indirectly via cost-collector.test.ts (which covers the integration flow only, not every
// function's edge cases in enough depth).

describe('computeTopServiceMovers', () => {
  it('returns the top increasing and top decreasing services by absolute $ delta, capped at 5 per group', () => {
    const previous = [
      { service: 'EC2', amountUsd: 100 },
      { service: 'RDS', amountUsd: 50 },
      { service: 'S3', amountUsd: 20 },
      { service: 'Lambda', amountUsd: 30 },
      { service: 'NAT', amountUsd: 10 },
      { service: 'CloudWatch', amountUsd: 5 },
      { service: 'Backup', amountUsd: 8 },
    ];
    const current = [
      { service: 'EC2', amountUsd: 150 }, // +50
      { service: 'RDS', amountUsd: 40 }, // -10
      { service: 'S3', amountUsd: 25 }, // +5
      { service: 'Lambda', amountUsd: 10 }, // -20
      { service: 'NAT', amountUsd: 10 }, // 0 -> excluded from both groups
      { service: 'CloudWatch', amountUsd: 55 }, // +50 (tied with EC2 but order is stable per input)
      { service: 'Backup', amountUsd: 1 }, // -7
    ];

    const { increased, decreased } = computeTopServiceMovers(current, previous);

    // NAT has deltaUsd === 0 -> does not appear in either group.
    expect(increased.find((m) => m.service === 'NAT')).toBeUndefined();
    expect(decreased.find((m) => m.service === 'NAT')).toBeUndefined();

    expect(increased.map((m) => m.service)).toEqual(['EC2', 'CloudWatch', 'S3']);
    expect(increased[0]).toEqual({ service: 'EC2', currentMonthUsd: 150, previousMonthUsd: 100, deltaUsd: 50, deltaPercent: 50 });

    expect(decreased.map((m) => m.service)).toEqual(['Lambda', 'RDS', 'Backup']);
    expect(decreased[0]).toEqual({ service: 'Lambda', currentMonthUsd: 10, previousMonthUsd: 30, deltaUsd: -20, deltaPercent: -(20 / 30) * 100 });
  });

  it('a service that appears only in the current month (newly incurred) -> treats previousMonthUsd = 0, deltaPercent = null', () => {
    const { increased } = computeTopServiceMovers([{ service: 'NewService', amountUsd: 42 }], []);
    expect(increased).toEqual([{ service: 'NewService', currentMonthUsd: 42, previousMonthUsd: 0, deltaUsd: 42, deltaPercent: null }]);
  });

  it('a service that appears only in the previous month (no longer incurred) -> treats currentMonthUsd = 0, deltaPercent = -100', () => {
    const { decreased } = computeTopServiceMovers([], [{ service: 'GoneService', amountUsd: 42 }]);
    expect(decreased).toEqual([{ service: 'GoneService', currentMonthUsd: 0, previousMonthUsd: 42, deltaUsd: -42, deltaPercent: -100 }]);
  });

  it('both months empty -> both lists empty, no error', () => {
    expect(computeTopServiceMovers([], [])).toEqual({ increased: [], decreased: [] });
  });

  it('caps at 5 services per group even when more than 5 services increased', () => {
    const previous = Array.from({ length: 8 }, (_, i) => ({ service: `svc-${i}`, amountUsd: 10 }));
    const current = Array.from({ length: 8 }, (_, i) => ({ service: `svc-${i}`, amountUsd: 10 + (i + 1) })); // increasing with i
    const { increased } = computeTopServiceMovers(current, previous);
    expect(increased).toHaveLength(5);
    // Top 5 increasing services: svc-7 (+8) .. svc-3 (+4).
    expect(increased.map((m) => m.service)).toEqual(['svc-7', 'svc-6', 'svc-5', 'svc-4', 'svc-3']);
  });
});

describe('buildMonthlyCostSummaries', () => {
  it('first month in the history: deltaUsd=0, deltaPercent=null, top movers empty (no previous month to compare against)', () => {
    const entries: RawMonthlyCostEntry[] = [{ month: '2026-01', byService: [{ service: 'EC2', amountUsd: 100 }] }];
    const [summary] = buildMonthlyCostSummaries(entries);
    expect(summary).toEqual({
      month: '2026-01',
      totalUsd: 100,
      deltaUsd: 0,
      deltaPercent: null,
      topIncreasedServices: [],
      topDecreasedServices: [],
    });
  });

  it('second month onward: correctly computes the $/% delta against the IMMEDIATELY PRECEDING month in the array, with top movers', () => {
    const entries: RawMonthlyCostEntry[] = [
      { month: '2026-01', byService: [{ service: 'EC2', amountUsd: 100 }] },
      { month: '2026-02', byService: [{ service: 'EC2', amountUsd: 150 }] },
    ];
    const [, second] = buildMonthlyCostSummaries(entries);
    expect(second.month).toBe('2026-02');
    expect(second.totalUsd).toBe(150);
    expect(second.deltaUsd).toBe(50);
    expect(second.deltaPercent).toBe(50);
    expect(second.topIncreasedServices).toEqual([{ service: 'EC2', currentMonthUsd: 150, previousMonthUsd: 100, deltaUsd: 50, deltaPercent: 50 }]);
    expect(second.topDecreasedServices).toEqual([]);
  });

  it('previous month total cost = 0 (e.g. an entirely new service) -> overall deltaPercent = null', () => {
    const entries: RawMonthlyCostEntry[] = [
      { month: '2026-01', byService: [] },
      { month: '2026-02', byService: [{ service: 'EC2', amountUsd: 50 }] },
    ];
    const [, second] = buildMonthlyCostSummaries(entries);
    expect(second.deltaUsd).toBe(50);
    expect(second.deltaPercent).toBeNull();
  });

  it('empty array -> returns an empty array', () => {
    expect(buildMonthlyCostSummaries([])).toEqual([]);
  });

  it('multiple consecutive months: each month only compares against the month IMMEDIATELY BEFORE it, not the first month', () => {
    const entries: RawMonthlyCostEntry[] = [
      { month: '2026-01', byService: [{ service: 'EC2', amountUsd: 100 }] },
      { month: '2026-02', byService: [{ service: 'EC2', amountUsd: 200 }] },
      { month: '2026-03', byService: [{ service: 'EC2', amountUsd: 150 }] },
    ];
    const summaries = buildMonthlyCostSummaries(entries);
    expect(summaries[1].deltaUsd).toBe(100); // 200 - 100
    expect(summaries[2].deltaUsd).toBe(-50); // 150 - 200, against month 02 not month 01
  });
});

// ---- Diffing cost-optimization findings ----

function makeFinding(overrides: Partial<RecommendationItem>): RecommendationItem {
  return {
    id: 'compute:ec2-instance:i-1:ec2LowCpu',
    category: 'compute',
    resourceType: 'ec2-instance',
    resourceId: 'i-1',
    resourceName: 'web-1',
    currentState: 'Low CPU',
    recommendedAction: 'Rightsizing',
    estimatedMonthlySavingsUsd: null,
    risk: 'low',
    priority: 'high',
    findingType: 'ec2LowCpu',
    ...overrides,
  };
}

describe('isNewFinding', () => {
  it('true when id is not present in previousItems', () => {
    expect(isNewFinding(makeFinding({ id: 'a' }), [makeFinding({ id: 'b' })])).toBe(true);
  });

  it('false when id already exists in previousItems (matches EXACTLY by id, not by other fields)', () => {
    const previous = [makeFinding({ id: 'a', currentState: 'different content but same id' })];
    expect(isNewFinding(makeFinding({ id: 'a' }), previous)).toBe(false);
  });

  it('previousItems empty -> always true (first run, every finding is "new")', () => {
    expect(isNewFinding(makeFinding({ id: 'a' }), [])).toBe(true);
  });
});

describe('findNewHighPriorityFindings', () => {
  it('returns only findings with priority=high AND new (not present in previousItems)', () => {
    const previous = [makeFinding({ id: 'old-high', priority: 'high' })];
    const current = [
      makeFinding({ id: 'old-high', priority: 'high' }), // old -> excluded
      makeFinding({ id: 'new-high', priority: 'high' }), // new + high -> kept
      makeFinding({ id: 'new-medium', priority: 'medium' }), // new but not high -> excluded
      makeFinding({ id: 'new-low', priority: 'low' }), // new but not high -> excluded
    ];
    const result = findNewHighPriorityFindings(current, previous);
    expect(result.map((f) => f.id)).toEqual(['new-high']);
  });

  it('previousItems empty (first run) -> every priority=high finding is treated as new', () => {
    const current = [makeFinding({ id: 'a', priority: 'high' }), makeFinding({ id: 'b', priority: 'low' })];
    const result = findNewHighPriorityFindings(current, []);
    expect(result.map((f) => f.id)).toEqual(['a']);
  });

  it('currentItems empty -> returns empty', () => {
    expect(findNewHighPriorityFindings([], [makeFinding({ id: 'a' })])).toEqual([]);
  });
});

describe('sumEstimatedMonthlySavings', () => {
  it('sums estimatedMonthlySavingsUsd, skipping null', () => {
    const items = [
      makeFinding({ id: 'a', estimatedMonthlySavingsUsd: 10 }),
      makeFinding({ id: 'b', estimatedMonthlySavingsUsd: null }),
      makeFinding({ id: 'c', estimatedMonthlySavingsUsd: 5.5 }),
    ];
    expect(sumEstimatedMonthlySavings(items)).toBe(15.5);
  });

  it('empty array -> 0', () => {
    expect(sumEstimatedMonthlySavings([])).toBe(0);
  });

  it('every estimatedMonthlySavingsUsd is null -> 0', () => {
    const items = [makeFinding({ id: 'a', estimatedMonthlySavingsUsd: null }), makeFinding({ id: 'b', estimatedMonthlySavingsUsd: null })];
    expect(sumEstimatedMonthlySavings(items)).toBe(0);
  });
});
