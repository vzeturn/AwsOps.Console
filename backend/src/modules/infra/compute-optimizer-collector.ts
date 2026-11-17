import {
  GetEC2InstanceRecommendationsCommand,
  GetRDSDatabaseRecommendationsCommand,
  GetEnrollmentStatusCommand,
} from '@aws-sdk/client-compute-optimizer';
import { logger } from '../../shared-kernel/logger.js';
import { getComputeOptimizerClient } from '../../core/aws-clients.js';

/**
 * `compute-optimizer-collector.ts` — the OFFICIAL rightsizing data source from AWS Compute
 * Optimizer, replacing `infra-review-collector.ts`'s own simple threshold on average 30-day CPU
 * (the old `ec2LowCpu`/`rdsLowCpu` rules based on `CPUUtilization` AVERAGE — easily "blind" to
 * bursty workloads: an instance can have low average CPU but hit 100% at peak load, meaning it's
 * actually UNDER-provisioned, not over — see the real case `i-0a1b2c3d4e5f60001` that was found).
 * Compute Optimizer uses percentile-based CPU (P99.5 by default) + headroom + Memory (via
 * CloudWatch Agent if present) — much more accurate than the homegrown rule above, and this is
 * the STANDARD data source an enterprise should use (the AWS Well-Architected Cost Optimization
 * Pillar recommends Compute Optimizer as the primary rightsizing source, not a homegrown average-CPU threshold).
 *
 * Wraps errors separately following the EXACT pattern of the other collectors
 * (`ec2-collector.ts`/`rds-collector.ts`): a failure at any step (account not enrolled in
 * Compute Optimizer, missing permissions, throttling...) only makes this collector return
 * `enrolled: false`/empty maps — it does NOT throw, does NOT break
 * `infra-review-collector.ts`. `enrolled: false` or an instance missing from the map does NOT
 * mean "that resource is optimized" — the orchestrator MUST fall back to the old heuristic
 * (clearly flagged with lower confidence) in this case, it must not be treated as "no issue found".
 */
export interface ComputeOptimizerData {
  /** `true` when the account has enrolled in Compute Optimizer (status API returns 'Active').
   * `false` means BOTH maps below are ALWAYS empty — it does not mean "every resource is
   * optimized", just that there's no Compute Optimizer data to reference yet. */
  enrolled: boolean;
  /** Map of `instanceId` (`i-xxxx` form, NOT an ARN) -> Compute Optimizer's NORMALIZED `finding`
   * (see `normalizeFinding`/`NORMALIZED_FINDING` — use this value for comparisons, do NOT
   * compare against literal PascalCase/SCREAMING_SNAKE_CASE strings directly). An instance
   * missing from the map (even when `enrolled === true`) means Compute Optimizer doesn't have
   * enough data for it yet (newly created, missing CloudWatch history, or an unsupported
   * instance family) — do NOT treat it as 'OPTIMIZED'. */
  ec2FindingByInstanceId: Map<string, string>;
  /** Map of `dbInstanceIdentifier` -> Compute Optimizer's NORMALIZED `instanceFinding` (same
   * convention as `ec2FindingByInstanceId` above). Same caveat as above for instances missing from the map. */
  rdsFindingByDbInstanceId: Map<string, string>;
  /**
   * Map of `instanceId` -> RAW `findingReasonCodes` (not normalized — used as a display
   * string/matched against a known list of constants, see `EBS_ONLY_FINDING_REASON_CODES` in
   * `infra-review-collector.ts`) for EC2. FOUND IN THE WILD (case `i-0a1b2c3d4e5f60003`,
   * abc-uat-ec2-saleapp): Compute Optimizer can return `finding: OVER_PROVISIONED` with
   * `findingReasonCodes: ['EBSThroughputOverprovisioned']` — this reason has NOTHING to do with
   * the instance's compute size (CPU/Memory), it's about EBS throughput. Recommending "downsize
   * the instance" (the `ec2LowCpu` rule) in this case would be WRONG — that's why this field was
   * added, so the orchestrator can tell the difference. Empty if Compute Optimizer doesn't
   * return this field.
   */
  ec2FindingReasonCodesByInstanceId: Map<string, string[]>;
}

const EMPTY_RESULT: ComputeOptimizerData = {
  enrolled: false,
  ec2FindingByInstanceId: new Map(),
  rdsFindingByDbInstanceId: new Map(),
  ec2FindingReasonCodesByInstanceId: new Map(),
};

/**
 * Normalizes the `finding` value returned by Compute Optimizer before matching. VERIFIED IN THE
 * WILD (by calling the API directly, not just relying on the SDK's type declarations) that the 2
 * APIs `GetEC2InstanceRecommendations`/`GetRDSDatabaseRecommendations` are INCONSISTENT in
 * casing at runtime even on the same SDK version: RDS returns PascalCase as declared in the type
 * (`"Underprovisioned"`), but EC2 returns SCREAMING_SNAKE_CASE (`"UNDER_PROVISIONED"`) —
 * completely unlike its type declaration (`Finding.UNDER_PROVISIONED = "Underprovisioned"`).
 * Normalize to SCREAMING_SNAKE_CASE (strip spaces/underscores then compare as continuous
 * uppercase) to correctly match BOTH forms, avoiding dependence on any specific SDK/API version's casing in the future.
 */
function normalizeFinding(finding: string | undefined): string | undefined {
  if (!finding) return undefined;
  // "Underprovisioned" -> "UNDERPROVISIONED", "UNDER_PROVISIONED" -> "UNDERPROVISIONED".
  return finding.toUpperCase().replace(/_/g, '');
}

/** Normalized values (see `normalizeFinding`) for the 4 possible findings — used as comparison
 * constants in `infra-review-collector.ts` instead of literal strings scattered across many places. */
export const NORMALIZED_FINDING = {
  UNDERPROVISIONED: 'UNDERPROVISIONED',
  OVERPROVISIONED: 'OVERPROVISIONED',
  OPTIMIZED: 'OPTIMIZED',
  NOT_OPTIMIZED: 'NOTOPTIMIZED',
} as const;

/** EC2 instance ARN: `arn:aws:ec2:<region>:<account>:instance/<instanceId>` — the instanceId is
 * the part after the last '/'. */
function parseInstanceIdFromArn(arn: string | undefined): string | undefined {
  if (!arn) return undefined;
  const idx = arn.lastIndexOf('/');
  return idx >= 0 && idx < arn.length - 1 ? arn.slice(idx + 1) : undefined;
}

/** RDS instance ARN: `arn:aws:rds:<region>:<account>:db:<dbInstanceIdentifier>` — the identifier
 * is the part after the last ':'. */
function parseDbInstanceIdFromArn(arn: string | undefined): string | undefined {
  if (!arn) return undefined;
  const idx = arn.lastIndexOf(':');
  return idx >= 0 && idx < arn.length - 1 ? arn.slice(idx + 1) : undefined;
}

/**
 * Checks enrollment status BEFORE calling GetEC2InstanceRecommendations/
 * GetRDSDatabaseRecommendations — an unenrolled account would make those 2 APIs throw
 * `OptInRequiredException`; checking first avoids calling an API guaranteed to fail and logs the
 * clear cause (instead of the generic error from those 2 APIs).
 */
async function isEnrolled(): Promise<boolean> {
  try {
    const res = await getComputeOptimizerClient().send(new GetEnrollmentStatusCommand({}));
    return res.status === 'Active';
  } catch (err) {
    logger.error(
      'compute-optimizer-collector: GetEnrollmentStatus failed (treating as not enrolled, returning empty)',
      err,
    );
    return false;
  }
}

/** Fetches ALL EC2 instance recommendations in the current account/region, paginating via
 * `nextToken`. Also returns RAW (not normalized) `findingReasonCodes` per instanceId — see
 * `ec2FindingReasonCodesByInstanceId` in `ComputeOptimizerData`. */
async function fetchAllEc2Findings(): Promise<{
  findingByInstanceId: Map<string, string>;
  reasonCodesByInstanceId: Map<string, string[]>;
}> {
  const findingByInstanceId = new Map<string, string>();
  const reasonCodesByInstanceId = new Map<string, string[]>();
  let nextToken: string | undefined;

  do {
    try {
      const res = await getComputeOptimizerClient().send(new GetEC2InstanceRecommendationsCommand({ nextToken }));
      for (const rec of res.instanceRecommendations ?? []) {
        const instanceId = parseInstanceIdFromArn(rec.instanceArn);
        const finding = normalizeFinding(rec.finding);
        if (instanceId && finding) findingByInstanceId.set(instanceId, finding);
        if (instanceId) reasonCodesByInstanceId.set(instanceId, rec.findingReasonCodes ?? []);
      }
      nextToken = res.nextToken;
    } catch (err) {
      logger.error(
        'compute-optimizer-collector: GetEC2InstanceRecommendations failed (skipping, returning what was fetched so far)',
        err,
      );
      return { findingByInstanceId, reasonCodesByInstanceId };
    }
  } while (nextToken);

  return { findingByInstanceId, reasonCodesByInstanceId };
}

/** Fetches ALL RDS instance recommendations in the current account/region, paginating via `nextToken`. */
async function fetchAllRdsFindings(): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  let nextToken: string | undefined;

  do {
    try {
      const res = await getComputeOptimizerClient().send(new GetRDSDatabaseRecommendationsCommand({ nextToken }));
      for (const rec of res.rdsDBRecommendations ?? []) {
        const dbInstanceIdentifier = parseDbInstanceIdFromArn(rec.resourceArn);
        const finding = normalizeFinding(rec.instanceFinding);
        if (dbInstanceIdentifier && finding) result.set(dbInstanceIdentifier, finding);
      }
      nextToken = res.nextToken;
    } catch (err) {
      logger.error(
        'compute-optimizer-collector: GetRDSDatabaseRecommendations failed (skipping, returning what was fetched so far)',
        err,
      );
      return result;
    }
  } while (nextToken);

  return result;
}

/**
 * A `recommendationOption` ranked `rank === 1` (Compute Optimizer's TOP choice) — used by
 * `ec2AutoRightsizing.ts`/`ec2-rightsize-applier.ts` to decide whether to apply the EXACT
 * instance type Compute Optimizer recommends (which may be a DIFFERENT family, e.g. moving to
 * Graviton/a family better suited to the workload) instead of just stepping up/down 1 tier
 * within the CURRENT family.
 */
export interface Ec2TopRecommendationOption {
  instanceType: string;
  /** `'VeryLow'` if AND ONLY IF current + recommended share the SAME CPU architecture (confirmed
   * via the AWS docs for `InstanceRecommendationOption.migrationEffort`) — the OFFICIAL signal
   * for whether a cross-family recommendation is architecturally safe (e.g. a Graviton/arm64
   * recommendation for a current x86_64 workload will NEVER be 'VeryLow'). `undefined` if AWS
   * doesn't return this field. */
  migrationEffort: string | undefined;
  /** Platform differences (Hypervisor/NetworkInterface/StorageInterface/InstanceStoreAvailability/
   * VirtualizationType/Architecture) between current and recommended — empty means Compute
   * Optimizer considers this a "transparent" change, with nothing further to consider about driver/compatibility. */
  platformDifferences: string[];
}

export interface Ec2InstanceRecommendationDetail {
  /** NORMALIZED `finding` — same `NORMALIZED_FINDING` convention as `ec2FindingByInstanceId`. */
  finding: string | undefined;
  findingReasonCodes: string[];
  /** `undefined` if Compute Optimizer has no `recommendationOptions` at all for this instance
   * (e.g. finding is OPTIMIZED — nothing to recommend), or no `rank === 1` option was found. */
  topRecommendationOption: Ec2TopRecommendationOption | undefined;
}

/**
 * Fetches the finding + TOP `recommendationOptions` (rank 1) for EXACTLY 1 instance — called
 * SEPARATELY (unlike `collectComputeOptimizerData()`, which surveys the WHOLE ACCOUNT for
 * `infra-review-collector.ts`) because it's used by `ec2-rightsize-applier.ts` AT THE EXACT
 * MOMENT the instance stops (needs the freshest data, which may be hours/days newer than the
 * evaluator's last run) — for JUST 1 instance, no need to paginate the whole account. Returns
 * `undefined` on failure (account not enrolled, missing permissions, instance has no data) — it
 * does NOT throw, the caller decides the fallback.
 */
export async function fetchEc2RecommendationDetail(instanceArn: string): Promise<Ec2InstanceRecommendationDetail | undefined> {
  try {
    const res = await getComputeOptimizerClient().send(new GetEC2InstanceRecommendationsCommand({ instanceArns: [instanceArn] }));
    const rec = res.instanceRecommendations?.[0];
    if (!rec) return undefined;

    const topOption = (rec.recommendationOptions ?? []).find((option) => option.rank === 1);

    return {
      finding: normalizeFinding(rec.finding),
      findingReasonCodes: rec.findingReasonCodes ?? [],
      topRecommendationOption:
        topOption?.instanceType !== undefined
          ? {
              instanceType: topOption.instanceType,
              migrationEffort: topOption.migrationEffort,
              platformDifferences: topOption.platformDifferences ?? [],
            }
          : undefined,
    };
  } catch (err) {
    logger.error(`compute-optimizer-collector: fetchEc2RecommendationDetail failed for ${instanceArn} (skipping, returning undefined)`, err);
    return undefined;
  }
}

/**
 * Surveys Compute Optimizer for the whole account: enrollment status + real EC2/RDS findings. An
 * unenrolled account (or a failing `GetEnrollmentStatus`) returns `enrolled: false` + 2 empty
 * maps IMMEDIATELY, without calling the 2 recommendation APIs (which would definitely fail with `OptInRequiredException`).
 */
export async function collectComputeOptimizerData(): Promise<ComputeOptimizerData> {
  const enrolled = await isEnrolled();
  if (!enrolled) return EMPTY_RESULT;

  const [ec2Result, rdsFindingByDbInstanceId] = await Promise.all([fetchAllEc2Findings(), fetchAllRdsFindings()]);

  return {
    enrolled,
    ec2FindingByInstanceId: ec2Result.findingByInstanceId,
    rdsFindingByDbInstanceId,
    ec2FindingReasonCodesByInstanceId: ec2Result.reasonCodesByInstanceId,
  };
}
