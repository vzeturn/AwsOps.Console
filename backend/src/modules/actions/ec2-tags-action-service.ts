import { CreateTagsCommand, DeleteTagsCommand } from '@aws-sdk/client-ec2';
import type { ActionExecutionResult } from '@ops-dashboard/shared';
import { getEc2Client } from '../../core/aws-clients.js';
import { logger } from '../../shared-kernel/logger.js';
import { LAST_PATCH_COMMAND_ID_TAG_KEY, LAST_PATCH_VERIFIED_DATE_TAG_KEY } from '../governance/patchScheduling.js';
import { PENDING_AUTO_RIGHTSIZE_TAG_KEY, LAST_AUTO_RIGHTSIZE_DATE_TAG_KEY } from '../governance/ec2AutoRightsizing.js';

const ec2 = getEc2Client();

/**
 * 4 tag keys written automatically by the system (patch-scheduler, schedule/rightsize markers) —
 * confirmed from `infra/ops-dashboard.yaml:764-765,922-923,2266` (`TagPrefix` = 'ops-dashboard').
 * Users must NOT edit/delete these keys via Ec2_UpdateTags — enforced at the app layer because
 * `aws:TagKeys` can only express "allow only these keys", not "any key EXCEPT these keys".
 *
 * Imported from the SAME constants `patch-scheduler.ts`/`ec2-rightsize-applier.ts` write with
 * (not re-hardcoded here) — tag-standard review 2026-10 found this file previously duplicated the
 * literal strings instead of importing them, so a `TAG_PREFIX` override (env var, see
 * `tagConventions.ts`) would have silently desynced this reserved-key check from the tags actually
 * being written, letting a user edit/delete a system-managed tag undetected.
 */
export const RESERVED_TAG_KEYS: readonly string[] = [
  LAST_PATCH_COMMAND_ID_TAG_KEY,
  LAST_PATCH_VERIFIED_DATE_TAG_KEY,
  PENDING_AUTO_RIGHTSIZE_TAG_KEY,
  LAST_AUTO_RIGHTSIZE_DATE_TAG_KEY,
];

function parseTagParams(params: Record<string, string | number>): { set: Record<string, string>; remove: string[] } | null {
  try {
    const set = typeof params.set === 'string' ? (JSON.parse(params.set) as Record<string, string>) : {};
    const remove = typeof params.remove === 'string' ? (JSON.parse(params.remove) as string[]) : [];
    return { set, remove };
  } catch {
    return null;
  }
}

/**
 * Executes `Ec2_UpdateTags` — deletes (`remove`) FIRST, then sets (`set`) (Section 4 spec: a key
 * present in both `remove` and `set` ends up with its new value, not deleted). If DeleteTags
 * fails, CreateTags is NOT attempted — outcome 'failure'. If DeleteTags succeeds but CreateTags
 * fails, outcome is 'partial' with `partialTagFailures` listing exactly which set keys failed to apply.
 */
export async function executeEc2UpdateTags(
  instanceId: string,
  params: Record<string, string | number>,
): Promise<ActionExecutionResult> {
  const parsed = parseTagParams(params);
  if (!parsed) {
    return { outcome: 'failure', reason: 'Invalid set/remove parameters (must be JSON)' };
  }
  const { set, remove } = parsed;

  const touchedKeys = [...Object.keys(set), ...remove];
  const reservedHit = touchedKeys.find((k) => RESERVED_TAG_KEYS.includes(k));
  if (reservedHit) {
    return {
      outcome: 'rejected',
      reason: `Tag key "${reservedHit}" is managed automatically by the system — it cannot be edited or removed via Ec2_UpdateTags.`,
    };
  }

  if (remove.length > 0) {
    try {
      await ec2.send(
        new DeleteTagsCommand({
          Resources: [instanceId],
          Tags: remove.map((key) => ({ Key: key })),
        }),
      );
    } catch (err) {
      logger.error(`ec2-tags-action-service: DeleteTags(${instanceId}) failed`, err);
      const message = err instanceof Error ? err.message : 'unknown error';
      return { outcome: 'failure', reason: `DeleteTags failed: ${message}` };
    }
  }

  const setKeys = Object.keys(set);
  if (setKeys.length > 0) {
    try {
      await ec2.send(
        new CreateTagsCommand({
          Resources: [instanceId],
          Tags: setKeys.map((key) => ({ Key: key, Value: set[key] })),
        }),
      );
    } catch (err) {
      logger.error(`ec2-tags-action-service: CreateTags(${instanceId}) failed`, err);
      const message = err instanceof Error ? err.message : 'unknown error';
      return {
        outcome: 'partial',
        reason: `Removed ${remove.length} tag(s) successfully, but setting new tags failed: ${message}`,
        partialTagFailures: setKeys,
      };
    }
  }

  return { outcome: 'success', newTags: set };
}
