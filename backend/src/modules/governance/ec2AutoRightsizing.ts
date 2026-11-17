// Lean_Lambda_Exception (Requirement 6.4a): direct imports, not `../infra/index.js`/
// `../ec2-management/index.js`. This pure helper is used by
// `infra-review-collector-fn`/`ec2-rightsize-applier-fn`/`time-of-day-trigger-fn` (lean standalone
// Lambdas), and both barrels re-export handler files (`get-infra.ts`/`get-topology.ts`,
// `actions-ec2-management.ts`/`instanceInInfraCache.ts`) that import `config.ts`/
// `shared-kernel/s3Cache.ts` at module scope — going through the barrels would make these Lambdas
// depend on env vars they are never granted (see `lambda-boot.test.ts`).
import { NORMALIZED_FINDING, type Ec2TopRecommendationOption } from '../infra/compute-optimizer-collector.js';
import { isEbsOnlyReason } from './ec2Rightsizing.js';
import { SCHEDULE_TAG_KEY, todayDateString } from './patchScheduling.js';
import { TAG_PREFIX } from '../ec2-management/tagConventions.js';

/**
 * `ec2AutoRightsizing.ts` — PURE functions (no AWS calls) for the `EC2_AutoRightsize` mechanism:
 * automatically scales an EC2 instance up/down when AWS Compute Optimizer TRULY CONFIRMS it (not
 * the average-CPU heuristic — lower confidence, used only to DISPLAY the `ec2LowCpu` finding for
 * the user to decide on their own, see `infra-review-collector.ts`), applying it at the instance's
 * VERY NEXT stop, following the existing natural on/off schedule (requirement: "apply it right at
 * the next reboot").
 *
 * TWO-PHASE MODEL (separates "deciding" from "applying" — a best practice that avoids mutating
 * while data is still being evaluated, reducing the risk of changing InstanceType exactly while
 * the instance is serving traffic):
 *  1. Evaluator (`infra-review-collector.ts`, runs daily — already has `ec2Items` +
 *     `computeOptimizerData` from 2 other collectors) calls `evaluateAutoRightsizeCandidates()` —
 *     ONLY sets/clears the `PENDING_AUTO_RIGHTSIZE_TAG_KEY` TAG on the instance, WITHOUT mutating
 *     `InstanceType` yet.
 *  2. Applier (`ec2-rightsize-applier.ts`, a NEW Lambda triggered by an EventBridge Rule when EC2
 *     transitions to `stopped`) reads that tag, RECOMPUTES the real target + checks CPU
 *     architecture compatibility (reusing `ec2Rightsizing.ts`, same as manual `EC2_Rightsize`)
 *     RIGHT AT APPLICATION TIME, changes `InstanceType`, then leaves the instance STOPPED —
 *     WITHOUT auto-starting it (the external on/off schedule system will turn it back on at its
 *     normal time, which serves as the natural "next reboot" confirmation without introducing
 *     extra unplanned downtime).
 *
 * SCOPE: ONLY instances with the `SCHEDULE_TAG_KEY` tag (same population as `patch-scheduler.ts`)
 * — they have a natural daily stop cycle so "the next stop" happens within a reasonable time (a
 * few hours), not waiting for an undetermined maintenance window. Instances running 24/7 WITHOUT
 * this tag are excluded from the automatic mechanism (the `ec2LowCpu`/`rdsLowCpu` finding is still
 * shown for the user to decide on their own via the existing 1-click `EC2_Rightsize`).
 */

/** Exempt tag — set by hand on a specific instance to FULLY EXCLUDE it from the automatic
 * mechanism (e.g. an instance running a special capacity experiment where the system shouldn't
 * auto-change its type). The tag value doesn't matter, only its PRESENCE. Prefix comes from
 * `TAG_PREFIX` (overridable via the same-named env var — see `tagConventions.ts`).
 * RENAMED to PascalCase 2026-10-08 (tag-standard rollout) — sub-key was `no-auto-rightsize`. */
export const NO_AUTO_RIGHTSIZE_TAG_KEY = `${TAG_PREFIX}:NoAutoRightsize`;

/** UNIFIED exclusion tag for BOTH automatic mechanisms (Compute Optimizer auto-rightsize AND
 * time-of-day sizing) — gradually replacing NO_AUTO_RIGHTSIZE_TAG_KEY (still read in parallel
 * during the transition period, see ec2-collector.ts, so it doesn't break exempt tags set by hand
 * previously). RENAMED to PascalCase 2026-10-08 — sub-key was `no-auto-sizing`. */
export const NO_AUTO_SIZING_TAG_KEY = `${TAG_PREFIX}:NoAutoSizing`;

/** Tag written by the evaluator — value `'up'` or `'down'`, read by the applier when the instance
 * stops. The applier deletes this tag itself after applying (success or failure) — this tag never
 * lingers after a stop has been handled. RENAMED to PascalCase 2026-10-08 — sub-key was
 * `pending-auto-rightsize`. The `aws:TagKeys` IAM Condition in `infra/ops-dashboard.yaml`
 * (`Ec2RightsizeApplierRole`, `InfraReviewCollectorRole`) references this via
 * `!Sub '${TagPrefix}:pending-auto-rightsize'` — a LITERAL sub-key suffix, NOT derived from this
 * constant — so it must be edited by hand to `!Sub '${TagPrefix}:PendingAutoRightsize'` in
 * lockstep with this change. */
export const PENDING_AUTO_RIGHTSIZE_TAG_KEY = `${TAG_PREFIX}:PendingAutoRightsize`;

/** Tag written by the applier AFTER successfully applying — a date value (per `PATCH_TIMEZONE`,
 * reused from `patchScheduling.ts` for consistency) in "YYYY-MM-DD" form, used to compute the
 * cooldown (see `AUTO_RIGHTSIZE_COOLDOWN_DAYS`). RENAMED to PascalCase 2026-10-08 — sub-key was
 * `last-auto-rightsize-date`. Same `aws:TagKeys` IAM Condition caveat as
 * `PENDING_AUTO_RIGHTSIZE_TAG_KEY` above applies here too. */
export const LAST_AUTO_RIGHTSIZE_DATE_TAG_KEY = `${TAG_PREFIX}:LastAutoRightsizeDate`;

/** Per-team time-of-day sizing override tags — set by hand on an instance to override the
 * computed min/max instance type bounds, or the scaling margin percentage, used by
 * `timeOfDayPolicy.ts`/`s3PolicyStore.ts` (`getTeamOverride`). Centralized here (not re-hardcoded
 * at the call site) so a `TAG_PREFIX` override stays in sync across every reader/writer.
 * RENAMED to PascalCase 2026-10-08 — sub-keys were `min-instance-type`/`max-instance-type`/
 * `scale-margin-percent`. Any instance tagged by hand with the old key must be re-tagged. */
export const MIN_INSTANCE_TYPE_TAG_KEY = `${TAG_PREFIX}:MinInstanceType`;
export const MAX_INSTANCE_TYPE_TAG_KEY = `${TAG_PREFIX}:MaxInstanceType`;
export const SCALE_MARGIN_PERCENT_TAG_KEY = `${TAG_PREFIX}:ScaleMarginPercent`;

/** Minimum number of days between 2 automatic InstanceType changes for the SAME instance —
 * prevents flip-flopping (Compute Optimizer switching back and forth between Under/Over-provisioned
 * over a few consecutive days due to short-term load swings) which would cause the instance to be
 * resized repeatedly, each time carrying a small risk (downtime while stopped, possible
 * incompatibility with other settings). 7 days is enough for Compute Optimizer to see a more
 * stable load trend at the new size before allowing another change. */
export const AUTO_RIGHTSIZE_COOLDOWN_DAYS = 7;

export type AutoRightsizeDirection = 'up' | 'down';

export type AutoRightsizeTagAction =
  | { action: 'setPending'; direction: AutoRightsizeDirection }
  | { action: 'clearPending' }
  | { action: 'noop' };

/**
 * Normalizes the Compute Optimizer finding (already through `normalizeFinding` from
 * `compute-optimizer-collector.ts`) + the raw `findingReasonCodes` into a trustworthy rightsize
 * direction — ONLY 2 cases, UNDERPROVISIONED ('up')/OVERPROVISIONED-that-is-not-EBS-only ('down'),
 * are reliable enough to automate; every other case (OPTIMIZED, NOT_OPTIMIZED, no data, or
 * OVERPROVISIONED due to EBS reasons only — see `isEbsOnlyReason`) returns `'none'`. NEVER uses
 * the average-CPU heuristic here — that's the core requirement distinguishing `EC2_AutoRightsize`
 * (automatic, needs high confidence) from the `ec2LowCpu` finding shown to the user (which can use
 * the heuristic, since the user reviews it themselves).
 */
export function classifyComputeOptimizerDirection(
  coFinding: string | undefined,
  coFindingReasonCodes: string[] | undefined,
): AutoRightsizeDirection | 'none' {
  if (coFinding === NORMALIZED_FINDING.UNDERPROVISIONED) return 'up';
  if (coFinding === NORMALIZED_FINDING.OVERPROVISIONED && !isEbsOnlyReason(coFindingReasonCodes)) return 'down';
  return 'none';
}

/**
 * "VeryLow" migration effort — per the AWS Compute Optimizer User Guide
 * (`InstanceRecommendationOption.migrationEffort`): this value ONLY occurs when the current AND
 * recommended instance type share the SAME CPU architecture. This is an OFFICIAL signal (not a
 * guess) to distinguish a SAFE cross-family recommendation (e.g. a new family with better
 * perf/price BUT still x86_64) from a RISKY one (e.g. x86_64 -> Graviton/arm64, where
 * migrationEffort would be 'Medium' if the workload type can't be determined, or 'Low' if Compute
 * Optimizer can infer it but an architecture change is still required — BOTH of these values are
 * NOT SAFE ENOUGH for unsupervised automation).
 */
const SAFE_MIGRATION_EFFORT = 'VeryLow';

/**
 * Decides whether to apply the EXACT instance type Compute Optimizer recommends (rank 1, which
 * may be a DIFFERENT family than the current one — e.g. moving to a new family with better
 * perf/price for the workload, meeting the requirement "whichever family is more optimal should
 * be applied") instead of only stepping up/down one size within the SAME family.
 *
 * SAFETY: ONLY trusts a cross-family recommendation when BOTH AWS-confirmed conditions are met —
 * a PURE function, no AWS calls, just re-reading fields already present in the response:
 *  1. `migrationEffort === 'VeryLow'` — AWS's OFFICIAL signal confirming the SAME CPU architecture
 *     (COMPLETELY ruling out the risk of a Graviton/arm64 recommendation for an x86_64 workload or
 *     vice versa — if the recommendation involves an architecture change, AWS NEVER returns
 *     'VeryLow', always 'Low'/'Medium'/'High').
 *  2. `platformDifferences` is empty — no hypervisor/network/storage driver differences that
 *     require the user's own judgment (e.g. moving to an instance that needs the NVMe driver
 *     reinstalled).
 *
 * If both conditions aren't met -> returns `undefined`, and the caller MUST fall back to
 * `computeEc2RightsizeTargetInDirection()` (step up/down within the same family) — never applies
 * a cross-family recommendation when there is any doubt.
 */
export function pickSafeCrossFamilyRecommendation(option: Ec2TopRecommendationOption | undefined): string | undefined {
  if (!option) return undefined;
  if (option.migrationEffort !== SAFE_MIGRATION_EFFORT) return undefined;
  if (option.platformDifferences.length > 0) return undefined;
  return option.instanceType;
}

export interface AutoRightsizeTagState {
  /** Whether the instance has the `SCHEDULE_TAG_KEY` tag (participates in the on/off schedule) — out of this mechanism's scope if `false`. */
  hasScheduleTag: boolean;
  /** Whether the instance has the `NO_AUTO_RIGHTSIZE_TAG_KEY` tag (manually excluded). */
  exempt: boolean;
  /** Current value of the `PENDING_AUTO_RIGHTSIZE_TAG_KEY` tag on the instance, `undefined` if not set. */
  currentPendingDirection: AutoRightsizeDirection | undefined;
  /** Current value of the `LAST_AUTO_RIGHTSIZE_DATE_TAG_KEY` tag, `undefined` if never applied before. */
  lastAutoRightsizeDate: string | undefined;
  /** Normalized `finding` (`normalizeFinding()` from `compute-optimizer-collector.ts`) for THIS
   * exact instance, `undefined` if Compute Optimizer has no data. */
  coFinding: string | undefined;
  /** The RAW `findingReasonCodes` accompanying `coFinding` — see `classifyComputeOptimizerDirection`. */
  coFindingReasonCodes: string[] | undefined;
}

/**
 * Decides the TAG action to take for an instance at the time the evaluator runs (`now`) — a PURE
 * function, no AWS calls. An instance out of scope (`!hasScheduleTag`) or excluded (`exempt`)
 * always gets `clearPending` if it currently has a pending tag (cleans up a tag that's no longer
 * valid), or `noop` otherwise.
 *
 * Within scope: if Compute Optimizer no longer confirms any reliable direction (`'none'`) —
 * clear the pending tag IMMEDIATELY if present (CO has changed its mind; a change that's no
 * longer needed shouldn't be applied, regardless of cooldown — applying cooldown here would be
 * the wrong direction, since cooldown only exists to delay a NEW change, not to preserve a change
 * that's no longer needed).
 *
 * If Compute Optimizer confirms a direction: keep the pending tag unchanged if it ALREADY matches
 * that direction (idempotent, avoids rewriting the tag every day unnecessarily). If a NEW pending
 * tag needs to be CREATED or its direction CHANGED, check the cooldown
 * (`AUTO_RIGHTSIZE_COOLDOWN_DAYS` counted from `lastAutoRightsizeDate`) — during the cooldown
 * period, `noop` (wait, don't create/change anything new).
 */
export function decideAutoRightsizeTagAction(state: AutoRightsizeTagState, now: Date): AutoRightsizeTagAction {
  const { hasScheduleTag, exempt, currentPendingDirection, lastAutoRightsizeDate } = state;

  if (!hasScheduleTag || exempt) {
    return currentPendingDirection ? { action: 'clearPending' } : { action: 'noop' };
  }

  const direction = classifyComputeOptimizerDirection(state.coFinding, state.coFindingReasonCodes);

  if (direction === 'none') {
    return currentPendingDirection ? { action: 'clearPending' } : { action: 'noop' };
  }

  if (currentPendingDirection === direction) {
    return { action: 'noop' };
  }

  if (isWithinCooldown(lastAutoRightsizeDate, now)) {
    return { action: 'noop' };
  }

  return { action: 'setPending', direction };
}

function isWithinCooldown(lastAutoRightsizeDate: string | undefined, now: Date): boolean {
  if (!lastAutoRightsizeDate) return false;
  const last = new Date(`${lastAutoRightsizeDate}T00:00:00Z`);
  if (Number.isNaN(last.getTime())) return false;
  const daysSince = (now.getTime() - last.getTime()) / (24 * 60 * 60 * 1000);
  return daysSince < AUTO_RIGHTSIZE_COOLDOWN_DAYS;
}

export interface AutoRightsizeCandidateInput extends AutoRightsizeTagState {
  instanceId: string;
  /** The instance's Name tag — used for display in the Discord Embed instead of the raw InstanceId
   * (requirement: "should only use instance/resource names, not IDs, since they're hard to read"). */
  name: string;
}

export interface AutoRightsizeCandidateResult {
  instanceId: string;
  name: string;
  tagAction: AutoRightsizeTagAction;
}

/**
 * Applies `decideAutoRightsizeTagAction()` to the ENTIRE instance list — a pure function, used by
 * `infra-review-collector.ts` (the evaluator). Returns only the instances that NEED a tag change
 * (`tagAction` other than `'noop'`) — the caller only needs to call `CreateTags`/`DeleteTags` for
 * these instances, not for EVERY instance on every run.
 */
export function evaluateAutoRightsizeCandidates(
  items: AutoRightsizeCandidateInput[],
  now: Date,
): AutoRightsizeCandidateResult[] {
  const results: AutoRightsizeCandidateResult[] = [];
  for (const item of items) {
    const tagAction = decideAutoRightsizeTagAction(item, now);
    if (tagAction.action !== 'noop') {
      results.push({ instanceId: item.instanceId, name: item.name, tagAction });
    }
  }
  return results;
}

/** Current "YYYY-MM-DD" per the operating timezone — re-exported from `patchScheduling.ts` so that
 * `ec2-rightsize-applier.ts` doesn't need to import a module dedicated to patching directly. */
export { todayDateString, SCHEDULE_TAG_KEY };
