/**
 * Public surface of the `ec2-management` domain module (backend-core-foundation Task 19):
 * EC2 instance type/tag management + SSM Run Command handlers/services, plus the shared helpers
 * that several OTHER domain modules (alerting, governance, security) depend on: EC2/NAT Gateway
 * name-tag resolution, EC2 uptime calculation, the infra-cache membership guard, S3 cache key
 * constants, tag-naming conventions, and the generic threshold-evaluation helpers.
 *
 * Only re-exports symbols that have a REAL external importer today (same convention as
 * `modules/security/index.ts`/`modules/alerting/index.ts`). Every current external importer in
 * this codebase (router.ts, action-execution-handler.ts, and the lib files in
 * alerting/governance/security/services/collectors that depend on the shared helpers below)
 * imports via a DIRECT relative file path rather than through this barrel — that is the
 * established pattern already in place for every other relocated module, not something new here.
 * This file exists to document the module's public surface and satisfy the one-barrel-per-module
 * requirement; it is not itself imported by any consumer yet.
 *
 * - `handler` (x4, renamed) — actions-ec2-management.ts, get-ec2-instance-types.ts,
 *   actions-run-command.ts, get-run-command-status.ts: imported by `router.ts`.
 *   (`modules/infra/get-infra.ts`/`get-topology.ts` are a DIFFERENT `handler`, from the `infra`
 *   module, also imported by `router.ts` — not part of this module's own surface.)
 * - `runSsmPreset` — imported by `action-execution-handler.ts`.
 * - `computeUptimeMinutes` — imported by `modules/alerting/alarm-baseline-manager.ts` and
 *   `modules/governance/patchScheduling.ts`.
 * - `fetchEc2NameTag`/`fetchNatGatewayNameTag`/`resolveEc2DisplayName` — imported by
 *   `modules/alerting/alarm-notifier.ts`/`health-report.ts`.
 * - `assertInstanceInInfraCache`/`EC2_INSTANCE_ID_PATTERN` — imported by
 *   `modules/security/actions-security-group.ts` and used internally by this module's own
 *   run-command handlers/services.
 * - `INFRA_CACHE_S3_KEY`/`COMPLIANCE_CACHE_S3_KEY`/`TOPOLOGY_CACHE_S3_KEY`/
 *   `MONITORING_CACHE_S3_KEY`/`MONITORING_CACHE_TTL_MS`/`isSnapshotFresh` — imported by
 *   `infra-collector.ts`, `modules/export/export-csv.ts`, `modules/compliance/get-compliance.ts`,
 *   `modules/infra/get-infra.ts`, `modules/infra/get-topology.ts`, `modules/monitoring/get-monitoring.ts`.
 * - `TAG_PREFIX`/`SCHEDULE_TAG_KEY`/`PATCH_TIMEZONE`/`DEPARTMENT_TAG_KEY` — imported by
 *   `modules/cost/cost-collector.ts`, `collectors/time-of-day-collector.ts`,
 *   `modules/governance/ec2AutoRightsizing.ts`/`patchScheduling.ts`/`time-of-day-trigger.ts`.
 * - `evalThreshold`/`evalRangeThreshold`/`stateThreshold`/`applyMonitoringExemption`/
 *   `MONITORING_EXEMPT_TAG_KEY` — imported by `modules/infra/infra-service.ts`,
 *   `modules/monitoring/monitoring-service/get-monitoring-data.ts`/`threshold-eval.ts`,
 *   `infra-review-collector/assessment-report-builder.ts`,
 *   `modules/governance/governance-exemption-auditor.ts`, `modules/cost/costThreshold.ts`.
 */
export { handler as ec2ManagementHandler } from './actions-ec2-management.js';
export { handler as ec2InstanceTypesHandler } from './get-ec2-instance-types.js';
export { handler as runCommandHandler } from './actions-run-command.js';
export { handler as runCommandStatusHandler } from './get-run-command-status.js';
export { runSsmPreset } from './ssm-run-command-action-service.js';
export { getRunCommandStatus } from './ssm-run-command-status-service.js';
export { computeUptimeMinutes } from './ec2Uptime.js';
export { fetchEc2NameTag, fetchNatGatewayNameTag, resolveEc2DisplayName } from './ec2NameResolver.js';
export { assertInstanceInInfraCache, EC2_INSTANCE_ID_PATTERN } from './instanceInInfraCache.js';
export {
  INFRA_CACHE_S3_KEY,
  COMPLIANCE_CACHE_S3_KEY,
  MONITORING_CACHE_S3_KEY,
  TOPOLOGY_CACHE_S3_KEY,
  MONITORING_CACHE_TTL_MS,
  isSnapshotFresh,
} from './infraCacheKey.js';
export { TAG_PREFIX, SCHEDULE_TAG_KEY, DEPARTMENT_TAG_KEY, PATCH_TIMEZONE } from './tagConventions.js';
export {
  evalThreshold,
  stateThreshold,
  evalRangeThreshold,
  applyMonitoringExemption,
  MONITORING_EXEMPT_TAG_KEY,
} from './thresholds.js';
