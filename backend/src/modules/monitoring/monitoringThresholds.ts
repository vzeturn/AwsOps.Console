/**
 * `monitoringThresholds.ts` — the SINGLE SOURCE OF TRUTH for the warn/critical thresholds used to
 * evaluate Realtime_Metric on Monitoring_Page (`monitoring-service.ts`) AND to build the standard
 * set of CloudWatch Alarms per resource type (`alarm-baseline-manager.ts`). Kept separate from
 * `monitoring-service.ts` so these 2 systems NEVER drift out of sync with each other — to change a
 * threshold, edit exactly 1 place here, and both the dashboard and the real CloudWatch Alarms
 * automatically line back up.
 *
 * These are PURE constants (no dependency on AWS SDK/network) — safe to import from any Lambda.
 */

// ---- EC2 ----
export const EC2_CPU_WARN_PERCENT = 80;
export const EC2_CPU_CRITICAL_PERCENT = 95;

// ---- EC2 CWAgent (mem/disk %) — shares 1 threshold pair for both metrics, matches evalMonitoringThreshold. ----
export const EC2_CWAGENT_WARN_PERCENT = 80;
export const EC2_CWAGENT_CRITICAL_PERCENT = 90;

/**
 * The SAME disk threshold expressed as "% FREE remaining", for Windows.
 *
 * The two OS families report disk space with OPPOSITE POLARITY:
 *
 *   Linux   `disk_used_percent`           — high is bad  -> GreaterThanOrEqualToThreshold, 90
 *   Windows `LogicalDisk % Free Space`    — LOW is bad   -> LessThanOrEqualToThreshold,    10
 *
 * Getting the Windows one the wrong way round yields an alarm that is SILENT EXACTLY WHEN THE DISK
 * IS FULL, which is worse than having no alarm at all because the alarm list looks like coverage.
 * `alarm-baseline-manager.test.ts` pins this polarity for that reason.
 *
 * Derived from `EC2_CWAGENT_CRITICAL_PERCENT` rather than written as a literal 10, so that changing
 * the disk policy in one place keeps Linux and Windows in agreement instead of silently drifting.
 */
export const HOST_DISK_FREE_CRITICAL_PERCENT = 100 - EC2_CWAGENT_CRITICAL_PERCENT;

// ---- RDS ----
export const RDS_CPU_WARN_PERCENT = 80;
export const RDS_CPU_CRITICAL_PERCENT = 90;

/** Average ReadLatency/WriteLatency (seconds) sustained over 15 minutes — a saturated or degraded storage path. */
export const RDS_IO_LATENCY_CRITICAL_SECONDS = 0.1;

/** % storage FREE (remaining) — falling below this threshold is bad (direction: 'below'). */
export const RDS_FREE_STORAGE_WARN_PERCENT = 20;
export const RDS_FREE_STORAGE_CRITICAL_PERCENT = 10;

/**
 * % RAM USED (used = 1 - freeable/total) — exceeding this threshold is bad (direction: 'above').
 *
 * Applies ONLY to engines that rely on the OS page cache (PostgreSQL/MySQL/MariaDB): on those
 * engines FreeableMemory accurately reflects remaining headroom, so % used is a reasonable
 * signal.
 *
 * Does NOT apply to SQL Server — see `RDS_SQLSERVER_FREEABLE_MEMORY_*_BYTES` below.
 */
export const RDS_FREEABLE_MEMORY_USED_WARN_PERCENT = 80;
export const RDS_FREEABLE_MEMORY_USED_CRITICAL_PERCENT = 90;

/**
 * A separate FreeableMemory threshold for SQL Server, measured in absolute FREE BYTES REMAINING
 * (direction: 'below') instead of % used.
 *
 * WHY THIS NEEDS TO BE SEPARATE
 *
 * SQL Server fills its buffer pool up to the `max server memory` setting and HOLDS onto it,
 * releasing memory only when the OS forces it to. RAM you pay for is meant to be used for caching,
 * so a SQL Server with a lot of "free" RAM is wasting a resource. On a healthy instance the
 * operating point therefore sits at a high, stable % used (commonly close to 90%) even though
 * there is no memory pressure: the OS reports abundant available physical memory, no memory grants
 * are pending, and page life expectancy stays high.
 *
 * Consequence: the generic 80%/90% "% used" thresholds produce a PERMANENT false alarm for SQL
 * Server. That is worse than no alarm, because it teaches operators to ignore the warning.
 *
 * The byte thresholds below are chosen at the level where the OS genuinely starts running tight:
 * below roughly 800 MiB Windows gets constrained, and below roughly 400 MiB SQL Server receives a
 * low-memory notification. A healthy instance sits above the warn threshold, so this does not
 * produce a false alarm, while still giving warning before it becomes a real incident.
 *
 * NOTE: RDS SQL Server runs on Windows, which does NOT publish the `SwapUsage` CloudWatch metric at
 * all. There is no swap-based backstop for SQL Server; the byte floors above are the ONLY
 * memory-pressure signal for these instances. If a stronger signal is wanted, it has to come from
 * inside SQL Server (page life expectancy, memory grants pending, `process_physical_memory_low`)
 * via Performance Insights or a query, not from SwapUsage.
 */
export const RDS_SQLSERVER_FREEABLE_MEMORY_WARN_BYTES = 800 * 1024 * 1024;
export const RDS_SQLSERVER_FREEABLE_MEMORY_CRITICAL_BYTES = 400 * 1024 * 1024;

/**
 * Whether an RDS `Engine` (the `DBInstance.Engine` value) is a SQL Server variant.
 * AWS uses these values: sqlserver-se, sqlserver-ee, sqlserver-ex, sqlserver-web.
 */
export function isSqlServerEngine(engine: string | undefined): boolean {
  return typeof engine === 'string' && engine.startsWith('sqlserver');
}

/**
 * SwapUsage, as a % of the instance's total RAM. Direction: 'above' (more swap = worse).
 *
 * WHY WARN IS NOT "> 0"
 *
 * Linux pages out idle memory opportunistically. On a healthy PostgreSQL/MySQL instance a small,
 * stable swap figure is expected and means nothing: it typically returns to zero every day and
 * does not accumulate. Warning on "> 0" therefore guarantees a warn that can never clear, which is
 * the same defect documented above for SQL Server FreeableMemory: a threshold whose normal
 * operating point is on the wrong side of it teaches operators to ignore the dashboard.
 *
 * 1% of RAM is far above the typical noise floor, and it scales with instance size instead of
 * hard-coding a byte value. Real memory pressure is caught by the FreeableMemory threshold;
 * meaningful swap alongside low FreeableMemory is the combination that matters, and that is what
 * the runbook tells the operator to check.
 */
export const RDS_SWAP_WARN_PERCENT_OF_RAM = 1;
export const RDS_SWAP_CRITICAL_PERCENT_OF_RAM = 10;

/** Read/WriteLatency — thresholds are designed in ms, but the CloudWatch RDS latency metric unit
 * is Seconds (evalMonitoringThreshold converts value*1000 before comparing — the CloudWatch alarm
 * must use a threshold in SECONDS, converted back when building PutMetricAlarm). */
export const RDS_LATENCY_WARN_MS = 20;
export const RDS_LATENCY_CRITICAL_MS = 50;

/**
 * Lookup table of RAM (GiB) by `DBInstanceClass`, used to compute % used for FreeableMemory/
 * SwapUsage (no AWS API directly returns an instance class's RAM). Add other instance classes
 * here when `AWS_Account` starts using a new one — a MISSING entry here makes FreeableMemory/
 * SwapUsage fall back to measured-only (doesn't throw, but loses the real % RAM warning).
 *
 * Take values from the AWS Pricing API (memory per instance class). A WRONG value is worse than a
 * missing one: a missing entry degrades to a visibly absent threshold, while a wrong entry produces
 * an authoritative-looking threshold at the wrong level.
 *
 * Burstable classes (`db.t*`) are throttled once their CPU credits run out, so sustained high CPU on
 * them deserves more attention than on fixed-performance classes. Memory-optimized classes (`db.r*`)
 * have the same vCPU count as the general-purpose class of the same size but twice the RAM.
 */
export const RDS_INSTANCE_RAM_GIB: Record<string, number> = {
  'db.m8i.large': 8,
  'db.t4g.large': 8,
  'db.m7g.large': 8,
  'db.m7g.xlarge': 16,
  'db.m7g.2xlarge': 32,
  'db.m8i.xlarge': 16,
  'db.r8i.large': 16,
  'db.r8i.xlarge': 32,
};

// ---- ALB ----
export const ALB_RESPONSE_TIME_WARN_SECONDS = 2;
export const ALB_RESPONSE_TIME_CRITICAL_SECONDS = 5;
/** UnHealthyHostCount: warnAt is fixed at 1 (>=1 unhealthy target is warn); criticalAt = the FULL
 * count of registered targets for that target group (computed dynamically at reconcile time — not
 * a fixed constant, see `alarm-baseline-manager.ts`). */
export const ALB_UNHEALTHY_HOST_WARN_COUNT = 1;

// ---- NLB (Network Load Balancer, namespace AWS/NetworkELB) ----
// Layer 4 — no TargetResponseTime (NLB doesn't terminate/inspect the application protocol), so
// the only meaningful standard alarm is target health, the SAME signal whose absence would leave
// the ALB unhealthy-hosts alarm silently in INSUFFICIENT_DATA (see
// `alarm-baseline-manager.ts`'s file header). warnAt fixed at 1 (>=1 unhealthy target is worth a
// look), same reasoning as ALB's own UnHealthyHostCount.
export const NLB_UNHEALTHY_HOST_WARN_COUNT = 1;

// ---- ECS_Service ----
export const ECS_CPU_WARN_PERCENT = 80;
export const ECS_CPU_CRITICAL_PERCENT = 95;
export const ECS_MEMORY_WARN_PERCENT = 85;
export const ECS_MEMORY_CRITICAL_PERCENT = 95;
