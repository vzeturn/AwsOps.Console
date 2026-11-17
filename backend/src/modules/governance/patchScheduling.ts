// Lean_Lambda_Exception (Requirement 6.4a): direct import, not `../ec2-management/index.js`.
// This pure helper is used by `patch-scheduler-fn`/`ec2-rightsize-applier-fn` (lean standalone
// Lambdas), and the barrel also re-exports handler files (`actions-ec2-management.ts`,
// `instanceInInfraCache.ts`) that import `config.ts`/`shared-kernel/s3Cache.ts` at module scope —
// going through the barrel would make these Lambdas depend on env vars they are never granted
// (see `lambda-boot.test.ts`).
import { computeUptimeMinutes } from '../ec2-management/ec2Uptime.js';
import { SCHEDULE_TAG_KEY, PATCH_TIMEZONE, TAG_PREFIX } from '../ec2-management/tagConventions.js';

export const PATCH_AFTER_START_MINUTES = 30;

export { SCHEDULE_TAG_KEY, PATCH_TIMEZONE };

// Split into 2 tags instead of the single "last-patch-date" used previously: command-id is written
// IMMEDIATELY after SendCommand is accepted by AWS (not necessarily finished running), while
// verified-date is ONLY written after GetCommandInvocation confirms Status=Success — this avoids
// treating "the command was sent" as "the patch is done" (the command could Fail/TimeOut while the
// old code still marked it patched, preventing the instance from being patched again).
// RENAMED to PascalCase 2026-10-08 (tag-standard rollout) — sub-keys were `last-patch-command-id`/
// `last-patch-verified-date`. The `aws:TagKeys` IAM Condition in `infra/ops-dashboard.yaml`
// (`PatchSchedulerRole`) references these via `!Sub '${TagPrefix}:last-patch-command-id'`/
// `!Sub '${TagPrefix}:last-patch-verified-date'` — LITERAL sub-key suffixes, NOT derived from
// these constants — so they must be edited by hand to `LastPatchCommandId`/
// `LastPatchVerifiedDate` in lockstep with this change.
export const LAST_PATCH_COMMAND_ID_TAG_KEY = `${TAG_PREFIX}:LastPatchCommandId`;
export const LAST_PATCH_VERIFIED_DATE_TAG_KEY = `${TAG_PREFIX}:LastPatchVerifiedDate`;

export function todayDateString(now: Date, timeZone: string = PATCH_TIMEZONE): string {
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  return formatter.format(now);
}

export interface PatchEligibilityInput {
  launchTime: Date | undefined;
  /** The date (todayDateString) of the patch command CURRENTLY AWAITING result confirmation, if any. */
  pendingCommandDate: string | undefined;
  /** The date (todayDateString) of the most recent patch CONFIRMED successful, if any. */
  verifiedDate: string | undefined;
  ssmOnline: boolean;
}

export function isEligibleForPatch(input: PatchEligibilityInput, now: Date): boolean {
  if (!input.ssmOnline) return false;
  if (!input.launchTime) return false;
  if (computeUptimeMinutes(input.launchTime, now) < PATCH_AFTER_START_MINUTES) return false;
  const today = todayDateString(now);
  if (input.verifiedDate === today) return false;
  if (input.pendingCommandDate === today) return false;
  return true;
}
