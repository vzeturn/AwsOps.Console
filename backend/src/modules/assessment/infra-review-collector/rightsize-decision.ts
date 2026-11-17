import { CreateTagsCommand, DeleteTagsCommand } from '@aws-sdk/client-ec2';
import { logger } from '../../../shared-kernel/logger.js';
// Lean_Lambda_Exception (Requirement 6.4a): direct imports, not
// `../../governance/index.js`/`../../infra/index.js` — see the exception comment in
// `assessment-report-builder.ts` (same module, same reason): `infra-review-collector-fn` is a
// lean standalone Lambda; the governance barrel re-exports `s3PolicyStore.ts` (which cycles back
// into `../assessment/index.js`, pulling in `config.ts`), and the infra barrel re-exports
// `get-infra.ts`/`get-topology.ts` (which import `shared-kernel/s3Cache.ts` -> `config.ts`).
import { isEbsOnlyReason } from '../../governance/ec2Rightsizing.js';
import { evaluateAutoRightsizeCandidates, PENDING_AUTO_RIGHTSIZE_TAG_KEY } from '../../governance/ec2AutoRightsizing.js';
import { NORMALIZED_FINDING } from '../../infra/compute-optimizer-collector.js';
import { RIGHTSIZE_FALLBACK_MAX_CPU_THRESHOLD_PERCENT } from './assessment-config.js';
import { ec2 } from './clients.js';

/**
 * Decides rightsizing for one compute resource (EC2/RDS) — gives ABSOLUTE PRIORITY to a REAL
 * finding from AWS Compute Optimizer (a more accurate data source — uses CPU percentile + headroom
 * + Memory, see `compute-optimizer-collector.ts`) whenever available for that exact resource;
 * ONLY falls back to our own heuristic (average CPU + cross-checking peak CPU) when Compute
 * Optimizer has NO data (account not enrolled, or the instance is too new/family unsupported).
 *
 * This is a PURE function (calls no AWS) — it receives `coFinding` (already looked up from a map
 * by the caller) plus measured CPU numbers, and returns a clear decision for the caller to build
 * the right `RecommendationItem`. Shared by both EC2 and RDS (the 2 CPU fields mean the same
 * thing, only resourceType differs at the caller).
 */
export type RightsizeDecision =
  | { kind: 'underprovisioned'; currentState: string }
  | { kind: 'rightsizeCandidate'; currentState: string }
  | { kind: 'none' };

export function decideRightsizing(input: {
  coFinding: string | undefined;
  /** The RAW (unnormalized) `findingReasonCodes` accompanying `coFinding` — used to exclude the
   * OVERPROVISIONED case when the reason is ONLY about EBS throughput/IOPS, not CPU/Memory (see
   * `isEbsOnlyReason`). `undefined`/empty = exclude nothing (keeps the old behavior). */
  coFindingReasonCodes?: string[];
  avgCpuPercent: number | null;
  maxCpuPercent: number | null;
  avgCpuThresholdPercent: number;
}): RightsizeDecision {
  const { coFinding, coFindingReasonCodes, avgCpuPercent, maxCpuPercent, avgCpuThresholdPercent } = input;

  // ---- Prioritize Compute Optimizer when real data exists for this exact resource ----
  // Compares against the NORMALIZED value (NORMALIZED_FINDING — see compute-optimizer-collector.ts):
  // `coFinding` passed in here is ALWAYS the collector's `normalizeFinding()` result
  // (SCREAMING_SNAKE_CASE with no underscores stripped), NEVER compared against the SDK's raw
  // PascalCase string.
  if (coFinding === NORMALIZED_FINDING.UNDERPROVISIONED) {
    return {
      kind: 'underprovisioned',
      currentState:
        'AWS Compute Optimizer confirms this resource is UNDERPROVISIONED — do NOT reduce size, consider increasing size or investigating the cause of high load.',
    };
  }
  // REAL-WORLD FINDING (case i-0a1b2c3d4e5f60003, abc-uat-ec2-saleapp): Compute Optimizer can
  // return OVERPROVISIONED with a reason that is ONLY about EBS throughput/IOPS (not CPU/Memory)
  // — recommending "reduce instance size" in this case would be WRONG (recommendationOptions is
  // empty because AWS also has no concrete size suggestion). Do NOT treat this as a trustworthy
  // rightsizeCandidate — fall through to the fallback average/peak CPU heuristic below, same as
  // when Compute Optimizer has no data for this resource.
  const isOverprovisionedButEbsOnly = coFinding === NORMALIZED_FINDING.OVERPROVISIONED && isEbsOnlyReason(coFindingReasonCodes);
  if (coFinding === NORMALIZED_FINDING.OVERPROVISIONED && !isOverprovisionedButEbsOnly) {
    return {
      kind: 'rightsizeCandidate',
      currentState: 'AWS Compute Optimizer confirms this resource is OVERPROVISIONED — a trustworthy rightsizing candidate.',
    };
  }
  if (coFinding === NORMALIZED_FINDING.OPTIMIZED || coFinding === NORMALIZED_FINDING.NOT_OPTIMIZED) {
    // Compute Optimizer has confirmed the resource is appropriately sized (or there isn't enough
    // data for a more confident assessment) — do NOT recommend rightsizing even if the heuristic
    // average CPU looks low, because this is a percentile/headroom-based assessment, more accurate
    // than the simple average heuristic.
    return { kind: 'none' };
  }

  // ---- Fallback: Compute Optimizer has no data for this resource (not enrolled, instance too
  // new, or family unsupported) — use the average CPU heuristic + cross-check peak CPU within the
  // SAME survey period to avoid a WRONG recommendation for burst-style workloads (see
  // RIGHTSIZE_FALLBACK_MAX_CPU_THRESHOLD_PERCENT). Requires BOTH avg/max values to have data —
  // missing max is treated fail-safe (no recommendation), never assuming "it's probably fine".
  if (avgCpuPercent === null || avgCpuPercent > avgCpuThresholdPercent) return { kind: 'none' };
  if (maxCpuPercent === null || maxCpuPercent > RIGHTSIZE_FALLBACK_MAX_CPU_THRESHOLD_PERCENT) return { kind: 'none' };

  return {
    kind: 'rightsizeCandidate',
    currentState: `Average CPU ${avgCpuPercent}% and max ${maxCpuPercent}% (both below threshold) during the survey period — AWS Compute Optimizer has no data for this resource yet, using the fallback heuristic (lower confidence than Compute Optimizer).`,
  };
}

/**
 * Applies the `EC2_AutoRightsize` tag changes (`setPending`/`clearPending`) decided by
 * `evaluateAutoRightsizeCandidates()` — `CreateTagsCommand`/`DeleteTagsCommand` touch ONLY the
 * single `PENDING_AUTO_RIGHTSIZE_TAG_KEY` tag, NOT any other tag on the instance (the IAM policy
 * is also scoped to exactly this `TagKeys` — see `infra/ops-dashboard.yaml`). An error on one
 * instance is ONLY logged, NEVER thrown — one instance failing to write its tag must not break
 * writing the main report or block processing of other instances.
 */
export async function applyAutoRightsizeTagChanges(
  changes: ReturnType<typeof evaluateAutoRightsizeCandidates>,
): Promise<{ setPending: { instanceId: string; name: string; direction: 'up' | 'down' }[] }> {
  const setPending: { instanceId: string; name: string; direction: 'up' | 'down' }[] = [];

  for (const change of changes) {
    try {
      if (change.tagAction.action === 'setPending') {
        await ec2.send(
          new CreateTagsCommand({
            Resources: [change.instanceId],
            Tags: [{ Key: PENDING_AUTO_RIGHTSIZE_TAG_KEY, Value: change.tagAction.direction }],
          }),
        );
        setPending.push({ instanceId: change.instanceId, name: change.name, direction: change.tagAction.direction });
      } else if (change.tagAction.action === 'clearPending') {
        await ec2.send(new DeleteTagsCommand({ Resources: [change.instanceId], Tags: [{ Key: PENDING_AUTO_RIGHTSIZE_TAG_KEY }] }));
      }
    } catch (err) {
      logger.error(
        `infra-review-collector: failed to update EC2_AutoRightsize tag for ${change.instanceId} (skipping, not throwing)`,
        err,
      );
    }
  }

  return { setPending };
}
