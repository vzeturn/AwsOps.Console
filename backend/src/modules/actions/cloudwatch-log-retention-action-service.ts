import { DescribeLogGroupsCommand, PutRetentionPolicyCommand } from '@aws-sdk/client-cloudwatch-logs';
import type { ActionExecutionResult } from '@ops-dashboard/shared';
import { getCloudWatchLogsClient } from '../../core/aws-clients.js';

/**
 * `cloudwatch-log-retention-action-service.ts` runs in `action-execution-fn` (a dedicated mutate
 * Lambda, role `ActionExecutionRole`). Executes the `CloudWatchLogGroup_SetRetention` Resource_Action —
 * sets a retention policy on a log group currently set to "Never Expire" (findingType
 * `cloudWatchLogGroupNoRetention` in `infra-review-collector.ts`). `logs:PutRetentionPolicy` only
 * applies to LOGS GOING FORWARD — existing logs older than the new retention period get deleted
 * gradually by AWS (NOT deleted all at once immediately), so this action is safe to set right away
 * without needing more confirmation beyond the standard Confirmation_Dialog.
 */
const cloudwatchLogs = getCloudWatchLogsClient();

/** Default retention days applied for the 1-click action — 90 days, a common value for
 * application logs per the AWS Well-Architected Cost Optimization Pillar (enough to investigate a
 * recent incident, without keeping data forever). An operator can manually set a different value
 * via the console if a longer/shorter retention is needed — this is just a sensible 1-click
 * default, not the only value allowed. */
const DEFAULT_RETENTION_DAYS = 90;

/** Valid `retentionInDays` values per the `PutRetentionPolicy` API (AWS only accepts these exact
 * numbers, not an arbitrary integer). */
const VALID_RETENTION_DAYS = new Set([
  1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653,
]);

/**
 * Executes `CloudWatchLogGroup_SetRetention`: re-reads the current `retentionInDays` AT THE TIME
 * OF EXECUTION (doesn't trust preview data, which may be stale), and only proceeds if the log
 * group STILL has no retention policy (`retentionInDays === undefined`/`null`).
 *
 * - Log group doesn't exist → `'rejected'`.
 * - Log group ALREADY has a retention policy (someone set it manually before execution) →
 *   `'rejected'` (doesn't overwrite an existing policy, to avoid accidentally changing a
 *   deliberately-made retention decision).
 * - `PutRetentionPolicy` fails → `'failure'`.
 */
export async function executeCloudWatchLogRetention(logGroupName: string): Promise<ActionExecutionResult> {
  let currentRetention: number | undefined;
  try {
    const { logGroups = [] } = await cloudwatchLogs.send(
      new DescribeLogGroupsCommand({ logGroupNamePrefix: logGroupName }),
    );
    const logGroup = logGroups.find((lg) => lg.logGroupName === logGroupName);
    if (!logGroup) {
      return { outcome: 'rejected', reason: `Log group ${logGroupName} not found at execution time.` };
    }
    currentRetention = logGroup.retentionInDays;
  } catch (err) {
    return { outcome: 'failure', reason: `Could not read the current state of log group ${logGroupName}: ${(err as Error).message}` };
  }

  if (currentRetention !== undefined) {
    return {
      outcome: 'rejected',
      reason: `Log group ${logGroupName} already has a retention policy (${currentRetention} days) at execution time — not overwriting.`,
    };
  }

  if (!VALID_RETENTION_DAYS.has(DEFAULT_RETENTION_DAYS)) {
    // Internal safeguard — DEFAULT_RETENTION_DAYS is a fixed constant in code, not derived from
    // external input, but we still check so that if this constant is ever changed to an invalid
    // value in the future, we fail loud instead of letting AWS return a confusing error.
    return { outcome: 'failure', reason: `Internal error: DEFAULT_RETENTION_DAYS=${DEFAULT_RETENTION_DAYS} is not valid per the AWS API.` };
  }

  try {
    await cloudwatchLogs.send(
      new PutRetentionPolicyCommand({ logGroupName, retentionInDays: DEFAULT_RETENTION_DAYS }),
    );
  } catch (err) {
    return { outcome: 'failure', reason: `PutRetentionPolicy failed for ${logGroupName}: ${(err as Error).message}` };
  }

  return { outcome: 'success', newRetentionDays: DEFAULT_RETENTION_DAYS };
}
