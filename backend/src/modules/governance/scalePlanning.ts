/**
 * `scalePlanning.ts` — pure logic (no AWS API calls) computing safe scale-out/capacity-increase
 * targets for 2 new Resource_Actions: `ECS_ScaleOut`/`RDS_IncreaseStorage`. Kept separate from
 * `preview-service.ts`/the action-services so BOTH preview (reads real AWS state then computes,
 * shown in the Confirmation_Dialog) AND execution (`action-execution-fn`, which RECOMPUTES
 * independently at execution time rather than trusting the value the client sent up —
 * defense-in-depth, the same principle as `ebs-action-service.ts` re-checking
 * `isVolumeUnattached` right before executing) use the EXACT SAME logic, with no duplication.
 */

/**
 * The new `desiredCount` target for `ECS_ScaleOut` — increases by at least 1 task, or 50% of the
 * current task count (rounded up) if that's larger, so the scale-out is meaningful in practice
 * (adding exactly 1 task to a service already running 20 tasks doesn't solve anything). Capped at
 * `maxCapacity` (from Application Auto Scaling's `DescribeScalableTargets`, if the service has
 * registered target-tracking autoscaling) — NEVER exceeds the limit the operator has set for that
 * service themselves. `maxCapacity === undefined` (service has no registered scalable target) ->
 * no further cap beyond `MAX_DESIRED_COUNT_HARD_CAP` (a last-resort safeguard against unbounded
 * scale-out if the autoscaling configuration can't be read).
 */
const MAX_DESIRED_COUNT_HARD_CAP = 50;

export function computeEcsScaleOutTarget(currentDesiredCount: number, maxCapacity: number | undefined): number {
  const increment = Math.max(1, Math.ceil(currentDesiredCount * 0.5));
  const cap = maxCapacity !== undefined ? Math.min(maxCapacity, MAX_DESIRED_COUNT_HARD_CAP) : MAX_DESIRED_COUNT_HARD_CAP;
  return Math.min(currentDesiredCount + increment, cap);
}

/**
 * The new `AllocatedStorage` (GiB) target for `RDS_IncreaseStorage` — increases by 20% over the
 * current value, per AWS's official recommendation ("Set the allocated storage target to at
 * least 20% more than your current storage usage" — RDS User Guide). AWS's `ModifyDBInstance`
 * automatically rounds up if the supplied value doesn't meet the mandatory 10% minimum increase,
 * so that edge case doesn't need handling here.
 */
const RDS_STORAGE_INCREASE_RATE = 0.2;

export function computeRdsStorageIncreaseTarget(currentAllocatedStorageGb: number): number {
  return Math.ceil(currentAllocatedStorageGb * (1 + RDS_STORAGE_INCREASE_RATE));
}
