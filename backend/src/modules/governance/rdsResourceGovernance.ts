/**
 * `rdsResourceGovernance.ts` — PURE logic (no AWS calls) for Resource_Action
 * `RDS_ApplyResourceGovernance`. Goal: stop a reporting/Power BI workload (or any heavy query)
 * from monopolizing the CPU/RAM of an RDS instance, which starves other services/features sharing
 * the SAME database of resources — per the requirement: "both databases must be optimized so
 * reports don't take all the resources and starve other features and services."
 *
 * The ROOT CAUSE was confirmed with real data (CloudWatch + DescribeDBParameters) for the 2
 * instances currently in `AWS_Account`:
 *
 * 1. `acme-rds-production-env` (SQL Server — has been resized MULTIPLE TIMES, see
 *    RDS_INSTANCE_VCPU/RDS_INSTANCE_RAM_GIB, currently db.r8i.xlarge = 4 vCPU/32 GiB RAM):
 *    - `max degree of parallelism`/`max server memory (mb)` MUST match the ACTUAL vCPU/RAM at
 *      execution time — each time the instance class is resized (this HAS happened MULTIPLE
 *      TIMES in practice, see the CloudTrail ModifyDBInstance history) without also updating these
 *      2 parameters, they drift out of sync with the new hardware: on a machine smaller than the
 *      parameters assume, "max degree of parallelism" ends up higher than the real vCPU count and
 *      causes CPU/thread contention; on a LARGER machine where the parameters are still sized for
 *      the OLD machine (e.g. buffer pool still at 12 GiB while the new machine has 32 GiB RAM),
 *      SQL Server fails to make use of the new RAM and ends up doing more disk I/O than necessary
 *      — CONFIRMED BY A REAL INCIDENT: after resizing db.r8i.large (16 GiB) -> db.r8i.xlarge (32
 *      GiB) on 2026-08-11, ReadLatency rose to 47.8ms (close to the 50ms critical threshold)
 *      because "max server memory (mb)" was still set to 12288 (sized for the old 16 GiB machine).
 *    - `query governor cost limit`: see the detailed adjustment history in
 *      `computeSqlServerTargetParameters` — currently 50000 after confirming legitimate reports
 *      reach a cost of ~30000.
 *
 * 2. `abc-prod-rds-postgres` (PostgreSQL 18, db.m7g.2xlarge = 8 vCPU/32 GiB RAM):
 *    - `statement_timeout` = 0 (disabled, the default) — a single reporting/Power BI query can run
 *      indefinitely, holding resources (CPU/locks/connections) with no limit.
 *    - `max_parallel_workers_per_gather` = the `DBInstanceClassMemory`-based default (no clear
 *      cap) — a single reporting/OLAP query can use MULTIPLE CPU cores IN PARALLEL at once,
 *      "stealing" CPU from other OLTP queries waiting their turn.
 *    - `work_mem` at its default has NO clear cap sized for the safety needs of a multi-tenant
 *      environment (many concurrent queries x a large work_mem can create RAM/swap pressure).
 *
 * This is a PURE function — given (engine, vCPU, RAM GiB), it computes values using standard
 * benchmark formulas (25% of RAM for the buffer pool/shared_buffers, keep 1 vCPU reserved for the
 * OS/other services, etc.) and returns the list of parameters to apply — it does NOT call
 * `rds:ModifyDBParameterGroup` itself (that's done by
 * `rds-resource-governance-action-service.ts`, which uses this SAME computed result for both the
 * preview and the real execution).
 */

export type RdsEngineFamily = 'sqlserver' | 'postgres';

/**
 * vCPU lookup table by `DBInstanceClass` — there is NO AWS API that directly returns the vCPU
 * count of an instance class (same reason `RDS_INSTANCE_RAM_GIB` has to exist in
 * `modules/monitoring/monitoringThresholds.ts` — no AWS API directly returns RAM either). Add more instance
 * classes here whenever `AWS_Account` starts using a new one — a MISSING entry causes
 * `RDS_ApplyResourceGovernance` to refuse to apply to that instance (fail-safe, never guesses the
 * vCPU count — see `rds-resource-governance-action-service.ts`). Confirmed via the AWS Pricing API
 * at the time this code was written (NOT made-up numbers):
 *  - db.m8i.large: 2 vCPU (Intel Xeon Scalable Granite Rapids).
 *  - db.m7g.2xlarge: 8 vCPU (AWS Graviton3).
 */
export const RDS_INSTANCE_VCPU: Record<string, number> = {
  'db.m8i.large': 2,
  'db.m7g.2xlarge': 8,
  // db.r8i.large: 2 vCPU (Intel Xeon Scalable Granite Rapids, same chip line as m8i.large) — the
  // new target for acme-rds-production-env, confirmed via the AWS Pricing API.
  'db.r8i.large': 2,
  // db.r8i.xlarge: 4 vCPU (same Granite Rapids chip line, double db.r8i.large) — the SECOND resize
  // of acme-rds-production-env (2026-08-11), confirmed via the AWS Pricing API.
  'db.r8i.xlarge': 4,
};

/** Infers the `RdsEngineFamily` from the real `Engine` value returned by `DescribeDBInstances`
 * (e.g. 'sqlserver-se'/'sqlserver-ee'/'sqlserver-web'/'sqlserver-ex' are all `sqlserver`;
 * 'postgres'/'aurora-postgresql' are both `postgres`). Returns `undefined` for an unsupported
 * engine (MySQL/MariaDB/Oracle...) — this action ONLY applies to the 2 families currently present
 * in `AWS_Account`, and never guesses a formula for an engine that hasn't been verified. */
export function detectEngineFamily(engine: string): RdsEngineFamily | undefined {
  const normalized = engine.toLowerCase();
  if (normalized.startsWith('sqlserver')) return 'sqlserver';
  if (normalized.includes('postgres')) return 'postgres';
  return undefined;
}

export interface RdsParameterChange {
  parameterName: string;
  /** The NEW value to apply — always a string because `rds:ModifyDBParameterGroup` requires it
   * (the `ParameterValue` API field is a string, even though the logical value is a number/bool). */
  newValue: string;
  reasonEn: string;
  reasonVi: string;
}

const MB_PER_GIB = 1024;

/**
 * Computes the RAM (GiB) that must be reserved for the OS/system on an RDS SQL Server instance —
 * an INDUSTRY-STANDARD formula (Jonathan Kehayias/SQLskills, cited by Microsoft Learn Q&A and AWS
 * re:Post, NOT a made-up number): 1 GiB base + 1 GiB per 4 GiB of RAM in the 4-16 GiB range + 1
 * GiB per 8 GiB of RAM ABOVE 16 GiB. Example: an 8 GiB machine -> reserve 2 GiB (1 + (8-4)/4); a 16
 * GiB machine -> reserve 4 GiB (1 + (16-4)/4); a 32 GiB machine -> reserve 6 GiB (1 + 3 +
 * (32-16)/8).
 *
 * FIX relative to the first version (which used a flat "80% of total RAM" for every machine size):
 * a flat percentage formula doesn't match reality — OS/RDS agent overhead is roughly FIXED in GiB
 * regardless of machine size, it doesn't scale with the percentage of RAM. On a SMALL machine (8
 * GiB), 20% (80% max memory) leaves only 1.6 GiB free — THINNER than the real recommendation (2
 * GiB); FreeableMemory was observed dropping to near 500MB on `acme-rds-production-env` (8 GiB) —
 * confirming the old 80% formula wasn't safe enough for small machines.
 */
function computeSqlServerOsReservationGib(memoryGib: number): number {
  if (memoryGib <= 4) return 1;
  if (memoryGib <= 16) return 1 + (memoryGib - 4) / 4;
  return 1 + 3 + (memoryGib - 16) / 8;
}

/**
 * Computes the standard SQL Server parameter set for an instance with `vcpuCount` cores /
 * `memoryGib` RAM:
 *  - `max degree of parallelism`: set to EXACTLY the real vCPU count, capped at 8 (Microsoft's
 *    standard recommendation for mixed OLTP+reporting workloads — never exceed the real core
 *    count, to avoid CPU contention).
 *  - `cost threshold for parallelism`: 50 (keeps the value already configured in the account — it
 *    is reasonable and doesn't need to change. Listed here only for transparency; it creates NO
 *    real change if the current value is already correct — see `computeSqlServerParameterChanges`,
 *    which returns only what ACTUALLY needs to change).
 *  - `max server memory (mb)`: total RAM MINUS the OS reservation computed by the
 *    industry-standard formula (see `computeSqlServerOsReservationGib` — 1GB + 1GB/4GB in the
 *    4-16GB range + 1GB/8GB above 16GB), NOT a fixed percentage for every machine size (see the
 *    rationale in `computeSqlServerOsReservationGib`).
 *  - `query governor cost limit`: 50000 — blocks any query whose estimated cost exceeds 50000 (an
 *    internal SQL Server query optimizer unit, not seconds). ADJUSTMENT HISTORY: initially 300 ->
 *    caused a REAL production INCIDENT (the HRMS timekeeping app reported "The query has been
 *    canceled because the estimated cost of this query (8628) exceeds the configured threshold of
 *    300" — cost 8628 was a normal OLTP query from the app, NOT a report/full-scan query that
 *    should be blocked) -> raised to 9000 -> raised AGAIN to 50000 (the current value) after
 *    confirming several legitimate business reports reach a cost of ~30000 (still legitimate
 *    queries, not full-scans that should be blocked) — 9000 would have WRONGLY blocked those
 *    reports. 50000 leaves a safety margin above the highest legitimate report cost observed
 *    (~30000) while still being able to block more extreme report/full-scan queries. This is the
 *    strongest available mechanism for "don't let reports take all the resources" on SQL Server
 *    Standard Edition (Resource Governor is Enterprise Edition only — the current instance is
 *    Standard Edition, see the RDS_ApplyResourceGovernance service) — BUT the threshold must stay
 *    high enough not to disrupt normal operation, prioritizing "don't break the app/legitimate
 *    reports" over "block as much as possible".
 */
export function computeSqlServerTargetParameters(vcpuCount: number, memoryGib: number): RdsParameterChange[] {
  const maxDop = Math.min(vcpuCount, 8);
  const osReservationGib = computeSqlServerOsReservationGib(memoryGib);
  const maxServerMemoryMb = Math.floor((memoryGib - osReservationGib) * MB_PER_GIB);
  const queryGovernorCostLimit = 50_000;

  return [
    {
      parameterName: 'max degree of parallelism',
      newValue: String(maxDop),
      reasonEn: `Set to the actual vCPU count (${vcpuCount}, capped at 8) — a value higher than available cores only causes CPU/thread contention between queries, it does not add real parallelism.`,
      reasonVi: `Set to the actual vCPU count (${vcpuCount}, capped at 8) — a value higher than available cores only causes CPU/thread contention between queries, it does not add real parallelism.`,
    },
    {
      parameterName: 'max server memory (mb)',
      newValue: String(maxServerMemoryMb),
      reasonEn: `Total RAM (${memoryGib} GiB) minus ${osReservationGib} GiB reserved for the OS (industry-standard formula: 1 GiB base + 1 GiB per 4 GiB of RAM up to 16 GiB, then 1 GiB per 8 GiB above that) — gives SQL Server a large buffer pool while keeping a fixed, appropriately-sized headroom for the OS regardless of instance size.`,
      reasonVi: `Total RAM (${memoryGib} GiB) minus ${osReservationGib} GiB reserved for the OS (industry-standard formula: 1 GiB base + 1 GiB per 4 GiB of RAM up to 16 GiB, then 1 GiB per 8 GiB above that) — gives SQL Server a large buffer pool while keeping a fixed, appropriately-sized headroom for the OS regardless of instance size.`,
    },
    {
      parameterName: 'query governor cost limit',
      newValue: String(queryGovernorCostLimit),
      reasonEn: `Set to ${queryGovernorCostLimit} (query optimizer cost units) — blocks any query whose estimated cost exceeds this before it even starts running, preventing an expensive report query from monopolizing CPU/IO. Normal OLTP queries are far below this threshold.`,
      reasonVi: `Set to ${queryGovernorCostLimit} (query optimizer cost units) — blocks any query whose estimated cost exceeds this before it even starts running, preventing an expensive report query from monopolizing CPU/IO. Normal OLTP queries are far below this threshold.`,
    },
  ];
}

/**
 * Computes the standard PostgreSQL parameter set for an instance with `vcpuCount` cores /
 * `memoryGib` RAM:
 *  - `statement_timeout`: 300000ms (5 minutes) — long enough for legitimate reporting/OLAP
 *    queries, short enough to stop a "runs forever" query holding resources with no limit
 *    (standard recommendation for a mixed OLTP+OLAP production environment).
 *  - `max_parallel_workers_per_gather`: caps at 50% of the real vCPU count (minimum 2) for a
 *    SINGLE query — prevents one reporting query from taking most of the instance's CPU cores,
 *    while still allowing large queries to parallelize to a reasonable degree.
 *  - `work_mem`: RAM(MB)/256 — an approximation of the formula the AWS RDS PostgreSQL Tuning Guide
 *    uses for `effective_cache_size`/`shared_buffers` (divided by /32768 KB = /32 MB, /16384 KB =
 *    /16 MB), using a more conservative factor (/256 MB is roughly ~0.4% RAM per connection) so
 *    that many concurrent connections times work_mem don't add up to more than the available RAM
 *    (each connection can ALLOCATE work_mem MULTIPLE times for different sort/hash join operations
 *    within the SAME query).
 */
export function computePostgresTargetParameters(vcpuCount: number, memoryGib: number): RdsParameterChange[] {
  const statementTimeoutMs = 300_000;
  const maxParallelWorkersPerGather = Math.max(2, Math.floor(vcpuCount / 2));
  const workMemKb = Math.floor((memoryGib * MB_PER_GIB * 1024) / 256);

  return [
    {
      parameterName: 'statement_timeout',
      newValue: String(statementTimeoutMs),
      reasonEn: `Set to ${statementTimeoutMs / 1000}s — long enough for legitimate reporting/OLAP queries, but stops a runaway query from holding CPU/locks/connections indefinitely.`,
      reasonVi: `Set to ${statementTimeoutMs / 1000}s — long enough for legitimate reporting/OLAP queries, but stops a runaway query from holding CPU/locks/connections indefinitely.`,
    },
    {
      parameterName: 'max_parallel_workers_per_gather',
      newValue: String(maxParallelWorkersPerGather),
      reasonEn: `Capped at ${maxParallelWorkersPerGather} (~50% of ${vcpuCount} vCPUs) — prevents a single reporting query from using most of the instance's CPU cores in parallel, while still allowing meaningful parallelism for large queries.`,
      reasonVi: `Capped at ${maxParallelWorkersPerGather} (~50% of ${vcpuCount} vCPUs) — prevents a single reporting query from using most of the instance's CPU cores in parallel, while still allowing meaningful parallelism for large queries.`,
    },
    {
      parameterName: 'work_mem',
      newValue: String(workMemKb),
      reasonEn: `Capped at ${(workMemKb / 1024).toFixed(0)} MB per sort/hash operation — bounds total memory pressure when many concurrent connections each run memory-heavy report queries, reducing swap risk.`,
      reasonVi: `Capped at ${(workMemKb / 1024).toFixed(0)} MB per sort/hash operation — bounds total memory pressure when many concurrent connections each run memory-heavy report queries, reducing swap risk.`,
    },
  ];
}

/**
 * Common entry point — dispatches by `engineFamily`, used by BOTH the preview (shown before
 * confirmation) AND the real execution (`rds-resource-governance-action-service.ts`), ensuring
 * both flows always compute the SAME result for the SAME input.
 */
export function computeResourceGovernanceTargetParameters(
  engineFamily: RdsEngineFamily,
  vcpuCount: number,
  memoryGib: number,
): RdsParameterChange[] {
  return engineFamily === 'sqlserver'
    ? computeSqlServerTargetParameters(vcpuCount, memoryGib)
    : computePostgresTargetParameters(vcpuCount, memoryGib);
}
