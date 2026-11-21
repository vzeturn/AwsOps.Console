/**
 * Public surface of the `cost` domain module (backend-core-foundation Task 22): the Cost tab
 * handler/service (Cost Explorer cache reader), the `cost-collector.ts` standalone Lambda that is
 * the ONLY caller of Cost Explorer's billed APIs (`GetCostAndUsage`/`GetCostForecast`), the pure
 * monthly-reporting/department-allocation/threshold helpers it depends on, and the
 * `savings-plans-collector.ts` raw-data collector used by `infra-review-collector`
 * (Requirement 5.1, 5.3).
 *
 * Only re-exports symbols that have a REAL external importer today (same convention as
 * `modules/compliance/index.ts`/`modules/security/index.ts`/`modules/ec2-management/index.ts`).
 * Every current external importer in this codebase imports via a DIRECT relative file path rather
 * than through this barrel — that is the established pattern already in place for every other
 * relocated module, not something new here. This file exists to document the module's public
 * surface and satisfy the one-barrel-per-module requirement; it is not itself imported by any
 * consumer yet.
 *
 * - `costHandler` (renamed from `handler`) — imported by `router.ts`.
 * - `getCostData` — imported by `modules/export/export-csv.ts`.
 * - `findNewHighPriorityFindings` — imported by
 *   `infra-review-collector/assessment-report-builder.ts`.
 * - `sumEstimatedMonthlySavings` — imported by `infra-review-collector/alert-embeds.ts`.
 * - `collectSavingsPlansCoverage` — imported by
 *   `infra-review-collector/assessment-report-builder.ts`.
 *
 * `shouldNotifyCostThresholdWorsened` (exported from `cost-collector.ts`) is NOT re-exported here
 * — it currently has no external importer, it is only called internally within
 * `cost-collector.ts`'s own `handler()` and exercised indirectly (via `handler()`, not by
 * importing the function itself) in `cost-collector.test.ts`.
 */
export { handler as costHandler } from './get-cost.js';
export { getCostData } from './cost-service.js';
export { findNewHighPriorityFindings, sumEstimatedMonthlySavings } from './costReporting.js';
export { collectSavingsPlansCoverage } from './savings-plans-collector.js';
