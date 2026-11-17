import type { CostByService, CostServiceMover, MonthlyCostSummary, RecommendationItem } from '@ops-dashboard/shared';

/**
 * `costReporting.ts` — PURE functions (no AWS calls) that compute the monthly cost Period_Report:
 * $/% delta between consecutive months, and "top services with the biggest cost increase/decrease"
 * — fulfilling the requirement "monthly/period-style reporting with a full comparison so you can
 * see increases and decreases". Split out from `cost-collector.ts` so it can be tested without
 * mocking Cost Explorer/SSM.
 */

/** 1 month of raw data from Cost Explorer — `month` in "YYYY-MM" format, already sorted in
 * ASCENDING chronological order (oldest month first) before being passed into
 * `buildMonthlyCostSummaries`. */
export interface RawMonthlyCostEntry {
  month: string;
  byService: CostByService[];
}

/** Max number of services shown in each "biggest increase"/"biggest decrease" group — enough to
 * immediately see the main cause without looking at the full service list. */
const TOP_MOVERS_LIMIT = 5;

function totalUsd(byService: CostByService[]): number {
  return byService.reduce((sum, s) => sum + s.amountUsd, 0);
}

/**
 * $/% delta of a value against the previous month's value. `deltaPercent` is `null` when
 * `previousUsd` is 0 (can't divide by 0 — the case of a service/total cost that's brand new, or
 * this is the first month in the history, with no previous month to compare against).
 */
function computeDelta(currentUsd: number, previousUsd: number): { deltaUsd: number; deltaPercent: number | null } {
  const deltaUsd = currentUsd - previousUsd;
  const deltaPercent = previousUsd === 0 ? null : (deltaUsd / previousUsd) * 100;
  return { deltaUsd, deltaPercent };
}

/**
 * Compares `byService` between 2 consecutive months, returns the top `TOP_MOVERS_LIMIT` services
 * with the biggest cost increase AND the top `TOP_MOVERS_LIMIT` services with the biggest cost
 * decrease (by absolute $ value, not %). A service that only appears in 1 of the 2 months is
 * treated as having a value of 0 in the month it's absent from (a newly appeared service =
 * increased from 0; a service with no more cost = decreased to 0).
 * A service with `deltaUsd === 0` (unchanged) is excluded from both groups — nothing worth
 * reporting.
 */
export function computeTopServiceMovers(
  current: CostByService[],
  previous: CostByService[],
): { increased: CostServiceMover[]; decreased: CostServiceMover[] } {
  const currentByName = new Map(current.map((s) => [s.service, s.amountUsd]));
  const previousByName = new Map(previous.map((s) => [s.service, s.amountUsd]));
  const allServiceNames = new Set([...currentByName.keys(), ...previousByName.keys()]);

  const movers: CostServiceMover[] = [];
  for (const service of allServiceNames) {
    const currentMonthUsd = currentByName.get(service) ?? 0;
    const previousMonthUsd = previousByName.get(service) ?? 0;
    const { deltaUsd, deltaPercent } = computeDelta(currentMonthUsd, previousMonthUsd);
    if (deltaUsd === 0) continue;
    movers.push({ service, currentMonthUsd, previousMonthUsd, deltaUsd, deltaPercent });
  }

  const increased = movers
    .filter((m) => m.deltaUsd > 0)
    .sort((a, b) => b.deltaUsd - a.deltaUsd)
    .slice(0, TOP_MOVERS_LIMIT);

  const decreased = movers
    .filter((m) => m.deltaUsd < 0)
    .sort((a, b) => a.deltaUsd - b.deltaUsd)
    .slice(0, TOP_MOVERS_LIMIT);

  return { increased, decreased };
}

/**
 * Builds the complete `MonthlyCostSummary[]` from a list of raw months ALREADY sorted in
 * ascending chronological order (oldest month at index 0). The first month has no previous month
 * to compare against — `deltaUsd: 0`, `deltaPercent: null`, `topIncreasedServices`/
 * `topDecreasedServices` empty (nothing to compare, NOT "no change" — different in meaning but
 * both reasonably represented as empty/0).
 * PURE function, no AWS calls — easy to test without mocking Cost Explorer.
 */
export function buildMonthlyCostSummaries(entries: RawMonthlyCostEntry[]): MonthlyCostSummary[] {
  return entries.map((entry, index) => {
    const currentTotal = totalUsd(entry.byService);
    const previous = index > 0 ? entries[index - 1] : undefined;

    if (!previous) {
      return {
        month: entry.month,
        totalUsd: currentTotal,
        deltaUsd: 0,
        deltaPercent: null,
        topIncreasedServices: [],
        topDecreasedServices: [],
      };
    }

    const previousTotal = totalUsd(previous.byService);
    const { deltaUsd, deltaPercent } = computeDelta(currentTotal, previousTotal);
    const { increased, decreased } = computeTopServiceMovers(entry.byService, previous.byService);

    return {
      month: entry.month,
      totalUsd: currentTotal,
      deltaUsd,
      deltaPercent,
      topIncreasedServices: increased,
      topDecreasedServices: decreased,
    };
  });
}

// ---- Diffs cost-optimization findings between 2 infra-review-collector runs — used for a
// proactive Discord notify when a NEW 'high' priority finding shows up (requirement: "cost
// optimization needs to be rolled out effectively and quickly, with continuous evaluation and
// improvement, to avoid unnecessary cost" — the operator shouldn't have to check the Assessment
// tab every day to find out about a new issue). ----

/**
 * `true` when this finding is NOT present in `previousItems` — matched by `id` (a stable
 * identifier `category:resourceType:resourceId:action`, see `RecommendationItem.id` in
 * shared/src/index.ts). Pure function.
 */
export function isNewFinding(item: RecommendationItem, previousItems: RecommendationItem[]): boolean {
  return !previousItems.some((prev) => prev.id === item.id);
}

/** List of `priority === 'high'` findings present in `currentItems` but NOT in `previousItems` —
 * this is the set of findings "new enough to report right away" for a Discord notify. A lower
 * priority finding, even if new, is NOT worth interrupting via the proactive channel (still shown
 * in full on the dashboard, just no push notification) — avoids spamming Discord with non-urgent
 * findings. Pure function. */
export function findNewHighPriorityFindings(
  currentItems: RecommendationItem[],
  previousItems: RecommendationItem[],
): RecommendationItem[] {
  return currentItems.filter((item) => item.priority === 'high' && isNewFinding(item, previousItems));
}

/** Sum of `estimatedMonthlySavingsUsd` (ignoring `null`) across a list of findings — used to
 * compute the "total estimated savings pending action" for the Discord notify content. Pure
 * function. */
export function sumEstimatedMonthlySavings(items: RecommendationItem[]): number {
  return items.reduce((sum, item) => sum + (item.estimatedMonthlySavingsUsd ?? 0), 0);
}
