/**
 * Public surface of the `governance` domain module (backend-core-foundation Task 18): 5 standalone
 * Lambda entrypoints (`ec2-rightsize-applier.ts`, `downsize-scheduler.ts`, `time-of-day-trigger.ts`,
 * `patch-scheduler.ts`, `governance-exemption-auditor.ts`) plus their supporting pure-logic modules
 * (`ec2AutoRightsizing.ts`, `ec2Rightsizing.ts`, `timeOfDayPolicy.ts`, `patchScheduling.ts`,
 * `rdsResourceGovernance.ts`, `scalePlanning.ts`, `policyStore.ts`, `s3PolicyStore.ts`).
 *
 * Only re-exports symbols that have a REAL external importer today, confirmed via grep across
 * `backend/src`:
 * - `computeEcsScaleOutTarget`/`computeRdsStorageIncreaseTarget` (scalePlanning.ts) — imported by
 *   `modules/actions/preview-service.ts`, `modules/actions/ecs-scale-action-service.ts`,
 *   `modules/actions/rds-storage-action-service.ts`.
 * - `areArchitecturesCompatible`/`computeEc2RightsizeTarget`/`fetchFamilySizes`/
 *   `parseInstanceType`/`isEbsOnlyReason` (ec2Rightsizing.ts) — imported by
 *   `modules/actions/preview-service.ts`, `modules/actions/ec2-rightsize-action-service.ts`,
 *   `infra-review-collector/assessment-report-builder.ts`,
 *   `infra-review-collector/rightsize-decision.ts`.
 * - `detectEngineFamily`/`computeResourceGovernanceTargetParameters`/`RDS_INSTANCE_VCPU`
 *   (rdsResourceGovernance.ts) — imported by `modules/actions/preview-service.ts`,
 *   `modules/actions/rds-resource-governance-action-service.ts`.
 * - `SCHEDULE_TAG_KEY` (patchScheduling.ts) — imported by `modules/infra/ec2-collector.ts`.
 * - `NO_AUTO_RIGHTSIZE_TAG_KEY`/`NO_AUTO_SIZING_TAG_KEY`/`PENDING_AUTO_RIGHTSIZE_TAG_KEY`/
 *   `LAST_AUTO_RIGHTSIZE_DATE_TAG_KEY`/`evaluateAutoRightsizeCandidates`/
 *   `classifyComputeOptimizerDirection` (ec2AutoRightsizing.ts) — imported by
 *   `modules/infra/ec2-collector.ts`, `infra-review-collector/assessment-report-builder.ts`,
 *   `infra-review-collector/rightsize-decision.ts`, `infra-review-collector/alert-embeds.ts`.
 * - `decideTimeOfDaySizing`/`computeOffPeakType`/`computePeakType`/`type HourlyMetricPoint`
 *   (timeOfDayPolicy.ts) — imported by `infra-review-collector/assessment-report-builder.ts`,
 *   `collectors/time-of-day-collector.ts`.
 * - `s3PolicyStore` (s3PolicyStore.ts) — imported by
 *   `infra-review-collector/assessment-report-builder.ts`.
 *
 * Every one of the importers above references the individual files directly (not this barrel)
 * since they were already wired that way before this module existed; this barrel exists for
 * consistency with every other Domain_Module (Requirement 6.2) and is available for future
 * callers. The 5 Lambda entrypoints in this module are NOT exported here — nothing imports their
 * `handler` directly, they are only bundled individually by `infra/scripts/build-artifacts.mjs`.
 * `policyStore.ts` (the `PolicyStore` interface) has no external importer either — only
 * `s3PolicyStore.ts` (its sole implementation, within this same module) references it.
 */
export { computeEcsScaleOutTarget, computeRdsStorageIncreaseTarget } from './scalePlanning.js';
export {
  areArchitecturesCompatible,
  computeEc2RightsizeTarget,
  fetchFamilySizes,
  parseInstanceType,
  isEbsOnlyReason,
} from './ec2Rightsizing.js';
export {
  detectEngineFamily,
  computeResourceGovernanceTargetParameters,
  RDS_INSTANCE_VCPU,
} from './rdsResourceGovernance.js';
export { SCHEDULE_TAG_KEY } from './patchScheduling.js';
export {
  NO_AUTO_RIGHTSIZE_TAG_KEY,
  NO_AUTO_SIZING_TAG_KEY,
  PENDING_AUTO_RIGHTSIZE_TAG_KEY,
  LAST_AUTO_RIGHTSIZE_DATE_TAG_KEY,
  evaluateAutoRightsizeCandidates,
  classifyComputeOptimizerDirection,
} from './ec2AutoRightsizing.js';
export {
  decideTimeOfDaySizing,
  computeOffPeakType,
  computePeakType,
  type HourlyMetricPoint,
  type TimeOfDaySizingInput,
} from './timeOfDayPolicy.js';
export { s3PolicyStore } from './s3PolicyStore.js';
