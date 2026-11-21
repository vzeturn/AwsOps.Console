import type { ThresholdMeta } from '@ops-dashboard/shared';
// Lean_Lambda_Exception (Requirement 6.4a): direct import, not `../ec2-management/index.js` —
// see the exception comment in `alerting/alarm-baseline-manager.ts` (same reason): this pure
// helper is used by `cost-collector-fn` (a lean standalone Lambda), and the barrel also
// re-exports handler files that pull in `config.ts` at module scope.
import { evalThreshold } from '../ec2-management/thresholds.js';

/**
 * `costThreshold.ts` — the SINGLE SOURCE OF TRUTH for evaluating `CostData`'s `ThresholdMeta`
 * (end-of-month forecast vs. previous month), used by BOTH `cost-service.ts` (displayed to the
 * frontend, recomputed from the cache on every request) AND `cost-collector.ts` (compares the
 * old/new threshold right after writing the new cache to decide whether to send an alert hub notify
 * — see `lib/costReporting.ts`, `shouldNotifyCostThresholdChange`). Split out so these 2 places
 * can NEVER drift out of sync with each other, following the same principle already applied in
 * `modules/monitoring/monitoringThresholds.ts`.
 */
export function evalCostThreshold(forecastMonthUsd: number, previousMonthUsd: number): ThresholdMeta {
  return evalThreshold(forecastMonthUsd, {
    warnAt: previousMonthUsd * 1.1,
    criticalAt: previousMonthUsd * 1.3,
    direction: 'above',
    okReason: 'Forecast is within a normal range compared to last month',
    warnReason: 'Forecast is >10% higher than last month',
    criticalReason: 'Forecast is >30% higher than last month',
  });
}
