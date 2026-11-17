/**
 * Public surface of the `monitoring` domain module (backend-core-foundation Task 26): the
 * Monitoring_Page handler/service (Realtime_Metric across EC2/RDS/ALB/EBS/ECS, `GET /monitoring`),
 * the Threshold_History handler/service (`GET /monitoring/history`), the CloudWatch-backed
 * `monitoring-service/` internals (Online_Resource loading, metric definitions, CWAgent detection,
 * threshold eval, console link, metric trend, final wiring in `getMonitoringData()`), and
 * `monitoringThresholds.ts` — the single source of truth for warn/critical thresholds shared with
 * `modules/alerting/alarm-baseline-manager.ts`'s standard CloudWatch Alarm set.
 *
 * Only re-exports symbols that have a REAL external importer today (same convention as
 * `modules/infra/index.ts`/`modules/assessment/index.ts`). Every current external importer in this
 * codebase imports via a DIRECT relative file path rather than through this barrel — the same
 * established pattern already in place for every other relocated module. This file exists to
 * document the module's public surface and satisfy the one-barrel-per-module requirement; it is
 * not itself imported by any consumer yet.
 *
 * - `monitoringHandler` (renamed from `handler`, get-monitoring.ts) — imported by `router.ts`.
 * - `monitoringHistoryHandler` (renamed from `handler`, get-monitoring-history.ts) — imported by
 *   `router.ts`.
 * - `buildConsoleLink` (re-exported by the `monitoring-service.ts` barrel, real implementation in
 *   `monitoring-service/console-link.ts`) — imported by `modules/alerting/alert-service.ts` to
 *   build the `CloudWatch_Console_Link` shown alongside each `AlarmSummary`.
 * - `EC2_CPU_CRITICAL_PERCENT`/`EC2_CWAGENT_CRITICAL_PERCENT`/
 *   `HOST_DISK_FREE_CRITICAL_PERCENT`/`RDS_CPU_CRITICAL_PERCENT`/
 *   `RDS_FREE_STORAGE_CRITICAL_PERCENT`/`RDS_FREEABLE_MEMORY_USED_CRITICAL_PERCENT`/
 *   `RDS_SQLSERVER_FREEABLE_MEMORY_CRITICAL_BYTES`/`RDS_INSTANCE_RAM_GIB`/`isSqlServerEngine`/
 *   `ALB_RESPONSE_TIME_CRITICAL_SECONDS`/`ALB_UNHEALTHY_HOST_WARN_COUNT`/
 *   `NLB_UNHEALTHY_HOST_WARN_COUNT`/`ECS_CPU_CRITICAL_PERCENT`/`ECS_MEMORY_CRITICAL_PERCENT`
 *   (monitoringThresholds.ts) — imported by `modules/alerting/alarm-baseline-manager.ts` to build
 *   the standard CloudWatch Alarm set with the SAME thresholds Monitoring_Page evaluates against.
 * - `RDS_INSTANCE_RAM_GIB` (monitoringThresholds.ts) — ALSO imported directly by
 *   `modules/actions/preview-service.ts` and
 *   `modules/actions/rds-resource-governance-action-service.ts` (RDS_ApplyResourceGovernance
 *   preview/execution, unrelated to alarms — needs the same RAM lookup table).
 *
 * Do NOT include symbols only used internally within this module (e.g. `getMonitoringData`,
 * `recordIfChanged`, `getHistory`, `loadOnlineResources`) — no external importer outside
 * `modules/monitoring/` references them today.
 */
export { handler as monitoringHandler } from './get-monitoring.js';
export { handler as monitoringHistoryHandler } from './get-monitoring-history.js';
export { buildConsoleLink } from './monitoring-service.js';
export {
  EC2_CPU_CRITICAL_PERCENT,
  EC2_CWAGENT_CRITICAL_PERCENT,
  HOST_DISK_FREE_CRITICAL_PERCENT,
  RDS_CPU_CRITICAL_PERCENT,
  RDS_FREE_STORAGE_CRITICAL_PERCENT,
  RDS_FREEABLE_MEMORY_USED_CRITICAL_PERCENT,
  RDS_SQLSERVER_FREEABLE_MEMORY_CRITICAL_BYTES,
  RDS_INSTANCE_RAM_GIB,
  isSqlServerEngine,
  ALB_RESPONSE_TIME_CRITICAL_SECONDS,
  ALB_UNHEALTHY_HOST_WARN_COUNT,
  NLB_UNHEALTHY_HOST_WARN_COUNT,
  ECS_CPU_CRITICAL_PERCENT,
  ECS_MEMORY_CRITICAL_PERCENT,
} from './monitoringThresholds.js';
