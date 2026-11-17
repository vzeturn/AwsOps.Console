import { GetSavingsPlansCoverageCommand, GetReservationCoverageCommand } from '@aws-sdk/client-cost-explorer';
import type { SavingsPlanCoverageByService } from '@ops-dashboard/shared';
import { logger } from '../../shared-kernel/logger.js';
import { getCostExplorerClient } from '../../core/aws-clients.js';

/**
 * Raw collector for Savings Plans/RI coverage, used by `infra-review-collector` (Requirement 5.1,
 * 5.3). Following the `cost-collector.ts` pattern: Cost Explorer only exists in the `us-east-1`
 * region, and this is one of the only 2 places (along with `cost-collector.ts`) granted
 * permission to call Cost Explorer — the router NEVER calls it directly (see design.md,
 * "Decisions requiring confirmation before Tasks" section).
 *
 * Functions here ONLY fetch raw data per service — they do NOT decide recommendations
 * themselves (estimating savings/commitment-purchase candidates is `buildSavingsPlanRecommendation`'s
 * job in `lib/recommendations.ts`, used by the `infra-review-collector.ts` orchestrator, task 7.1/3.1).
 */

/** Coverage survey period — the last 30 days, following the same 30-day survey period pattern used by the other collectors (ec2/serverless). */
const SURVEY_PERIOD_DAYS = 30;

function surveyPeriod(): { Start: string; End: string } {
  const end = new Date();
  const start = new Date(end.getTime() - SURVEY_PERIOD_DAYS * 24 * 60 * 60 * 1000);
  return { Start: start.toISOString().slice(0, 10), End: end.toISOString().slice(0, 10) };
}

interface ServiceCostTotals {
  onDemandUsd: number;
  coveredUsd: number;
}

/**
 * `GetSavingsPlansCoverage` groups by SERVICE — it directly returns both the uncovered cost
 * (`OnDemandCost`) and the cost covered by Savings Plans (`SpendCoveredBySavingsPlans`) in USD,
 * so they can be added straight into the per-service totals.
 */
async function loadSavingsPlansCoverage(): Promise<Map<string, ServiceCostTotals>> {
  const result = new Map<string, ServiceCostTotals>();

  const { SavingsPlansCoverages = [] } = await getCostExplorerClient().send(
    new GetSavingsPlansCoverageCommand({
      TimePeriod: surveyPeriod(),
      GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
    }),
  );

  for (const item of SavingsPlansCoverages) {
    const service = item.Attributes?.SERVICE ?? 'unknown';
    const onDemandUsd = Number(item.Coverage?.OnDemandCost ?? '0');
    const coveredUsd = Number(item.Coverage?.SpendCoveredBySavingsPlans ?? '0');
    const existing = result.get(service) ?? { onDemandUsd: 0, coveredUsd: 0 };
    result.set(service, {
      onDemandUsd: existing.onDemandUsd + onDemandUsd,
      coveredUsd: existing.coveredUsd + coveredUsd,
    });
  }

  return result;
}

/**
 * `GetReservationCoverage` groups by SERVICE — unlike Savings Plans, this API ONLY returns
 * `Coverage.CoverageCost.OnDemandCost` (the on-demand-rate cost of usage NOT covered by RIs);
 * there's no equivalent "covered cost" field in USD (only an hours-based ratio,
 * `CoverageHoursPercentage`, not a USD one). Since the collector ONLY fetches raw data — it must
 * not infer a USD figure that AWS doesn't provide — this function ONLY adds to `onDemandUsd`, it
 * doesn't compute `coveredUsd` for the RI portion.
 */
async function loadReservationCoverage(): Promise<Map<string, ServiceCostTotals>> {
  const result = new Map<string, ServiceCostTotals>();

  const { CoveragesByTime = [] } = await getCostExplorerClient().send(
    new GetReservationCoverageCommand({
      TimePeriod: surveyPeriod(),
      GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
    }),
  );

  for (const period of CoveragesByTime) {
    for (const group of period.Groups ?? []) {
      const service = group.Attributes?.SERVICE ?? 'unknown';
      const onDemandUsd = Number(group.Coverage?.CoverageCost?.OnDemandCost ?? '0');
      const existing = result.get(service) ?? { onDemandUsd: 0, coveredUsd: 0 };
      result.set(service, { onDemandUsd: existing.onDemandUsd + onDemandUsd, coveredUsd: existing.coveredUsd });
    }
  }

  return result;
}

/**
 * Collects compute coverage per service over the survey period (Requirement 5.1), merging
 * Savings Plans + Reserved Instances into 1 list per service (Requirement 5.3). Each source
 * (Savings Plans / RI) wraps its own errors following the `GetCostForecast` pattern in
 * `cost-collector.ts` — one source failing (throttling, missing permissions, no historical data
 * yet...) doesn't break the other, that part is just treated as empty.
 */
export async function collectSavingsPlansCoverage(): Promise<SavingsPlanCoverageByService[]> {
  const [savingsPlansTotals, reservationTotals] = await Promise.all([
    loadSavingsPlansCoverage().catch((err) => {
      logger.error('savings-plans-collector: GetSavingsPlansCoverage failed (skipping, treating as empty)', err);
      return new Map<string, ServiceCostTotals>();
    }),
    loadReservationCoverage().catch((err) => {
      logger.error('savings-plans-collector: GetReservationCoverage failed (skipping, treating as empty)', err);
      return new Map<string, ServiceCostTotals>();
    }),
  ]);

  const merged = new Map<string, ServiceCostTotals>();
  for (const [service, totals] of savingsPlansTotals) {
    merged.set(service, { ...totals });
  }
  for (const [service, totals] of reservationTotals) {
    const existing = merged.get(service) ?? { onDemandUsd: 0, coveredUsd: 0 };
    merged.set(service, {
      onDemandUsd: existing.onDemandUsd + totals.onDemandUsd,
      coveredUsd: existing.coveredUsd + totals.coveredUsd,
    });
  }

  return Array.from(merged.entries())
    .map(([service, { onDemandUsd, coveredUsd }]) => {
      const totalUsd = onDemandUsd + coveredUsd;
      return {
        service,
        onDemandUsd,
        coveredUsd,
        coveragePercent: totalUsd > 0 ? (coveredUsd / totalUsd) * 100 : 0,
      };
    })
    .sort((a, b) => b.onDemandUsd + b.coveredUsd - (a.onDemandUsd + a.coveredUsd));
}
