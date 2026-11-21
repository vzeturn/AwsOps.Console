import { DescribeInstancesCommand, CreateTagsCommand, DeleteTagsCommand } from '@aws-sdk/client-ec2';
import { DescribeInstanceInformationCommand, SendCommandCommand, GetCommandInvocationCommand } from '@aws-sdk/client-ssm';
import { getEc2Client, getSsmClient } from '../../core/aws-clients.js';
import {
  SCHEDULE_TAG_KEY,
  LAST_PATCH_COMMAND_ID_TAG_KEY,
  LAST_PATCH_VERIFIED_DATE_TAG_KEY,
  PATCH_TIMEZONE,
  todayDateString,
  isEligibleForPatch,
  type PatchEligibilityInput,
} from './patchScheduling.js';
// Lean_Lambda_Exception (Requirement 6.4a): direct imports, not `../alerting/index.js` — see the
// exception comment in `agent/ai-ops-agent.ts` (same reason): `patch-scheduler-fn` is a lean
// standalone Lambda.
import { postAlertEmbeds } from '../alerting/alertHook.js';
import { buildOpsNotificationEmbed } from '../alerting/opsNotification.js';
import { logger } from '../../shared-kernel/logger.js';

const ec2 = getEc2Client();
const ssm = getSsmClient();

interface CandidateInstance {
  instanceId: string;
  /** Name tag, falling back to instanceId if absent — read from the SAME DescribeInstances call
   * already needed for state/tags below (no extra API call), matching the same "no redundant
   * round-trip" convention used everywhere else in this project (e.g. `downsize-scheduler.ts`). */
  displayName: string;
  launchTime: Date | undefined;
  pendingCommandId: string | undefined;
  verifiedDate: string | undefined;
}

/** One instance's patch or verification failure — carries enough for an alert hub reader to act
 * without opening CloudWatch Logs first (which instance, what specifically went wrong). Replaces
 * the previous "just a count" summary, which required a log dive to answer either question. */
interface PatchFailure {
  displayName: string;
  stage: 'patch' | 'verify';
  reason: string;
}

async function discoverScheduledRunningInstances(): Promise<CandidateInstance[]> {
  const result: CandidateInstance[] = [];
  let nextToken: string | undefined;
  do {
    const { Reservations = [], NextToken } = await ec2.send(new DescribeInstancesCommand({ NextToken: nextToken }));
    for (const reservation of Reservations) {
      for (const instance of reservation.Instances ?? []) {
        if (instance.State?.Name !== 'running') continue;
        const instanceId = instance.InstanceId;
        if (!instanceId) continue;
        const tags = instance.Tags ?? [];
        const hasScheduleTag = tags.some((t) => t.Key === SCHEDULE_TAG_KEY);
        if (!hasScheduleTag) continue;
        result.push({
          instanceId,
          displayName: tags.find((t) => t.Key === 'Name')?.Value || instanceId,
          launchTime: instance.LaunchTime,
          pendingCommandId: tags.find((t) => t.Key === LAST_PATCH_COMMAND_ID_TAG_KEY)?.Value,
          verifiedDate: tags.find((t) => t.Key === LAST_PATCH_VERIFIED_DATE_TAG_KEY)?.Value,
        });
      }
    }
    nextToken = NextToken;
  } while (nextToken);
  return result;
}

async function discoverSsmOnlineInstanceIds(): Promise<Set<string>> {
  const onlineIds = new Set<string>();
  let nextToken: string | undefined;
  do {
    const { InstanceInformationList = [], NextToken } = await ssm.send(new DescribeInstanceInformationCommand({ NextToken: nextToken }));
    for (const info of InstanceInformationList) {
      if (info.InstanceId && info.PingStatus === 'Online') onlineIds.add(info.InstanceId);
    }
    nextToken = NextToken;
  } while (nextToken);
  return onlineIds;
}

/** The verification outcome for one pending patch command, used to decide the next step in handler().
 * `status` carries the raw SSM terminal status (e.g. "Failed", "TimedOut") ONLY when
 * `outcome === 'verify-failed'` — the concrete reason an alert hub reader needs, matching the same
 * "state the actual failure, not just that one occurred" principle `alarm-baseline-manager.ts`'s
 * `putFailures` list already follows. */
type VerifyOutcome = { outcome: 'verified' } | { outcome: 'verify-failed'; status: string } | { outcome: 'still-pending' };

/** Calls GetCommandInvocation for a (commandId, instanceId) pair awaiting confirmation from a
 * previous run. Success -> verified (caller writes verified-date). Terminal failure
 * (Failed/Cancelled/TimedOut) -> verify-failed (caller clears the command-id tag to allow patching
 * again). Pending/InProgress/Delayed -> still-pending (caller does nothing, waits for the next run). */
async function verifyPendingCommand(commandId: string, instanceId: string): Promise<VerifyOutcome> {
  const { Status } = await ssm.send(new GetCommandInvocationCommand({ CommandId: commandId, InstanceId: instanceId }));
  if (Status === 'Success') return { outcome: 'verified' };
  if (Status === 'Failed' || Status === 'Cancelled' || Status === 'TimedOut') return { outcome: 'verify-failed', status: Status };
  return { outcome: 'still-pending' };
}

async function markVerified(instanceId: string, now: Date): Promise<void> {
  try {
    await ec2.send(new CreateTagsCommand({ Resources: [instanceId], Tags: [{ Key: LAST_PATCH_VERIFIED_DATE_TAG_KEY, Value: todayDateString(now, PATCH_TIMEZONE) }] }));
  } catch (err) {
    logger.error(`patch-scheduler: failed to write the verified-date tag for ${instanceId}`, err);
  }
}

async function clearPendingCommandTag(instanceId: string): Promise<void> {
  try {
    await ec2.send(new DeleteTagsCommand({ Resources: [instanceId], Tags: [{ Key: LAST_PATCH_COMMAND_ID_TAG_KEY }] }));
  } catch (err) {
    logger.error(`patch-scheduler: failed to delete the command-id tag for ${instanceId}`, err);
  }
}

async function sendPatchCommand(instanceId: string): Promise<string | undefined> {
  const { Command } = await ssm.send(
    new SendCommandCommand({
      DocumentName: 'AWS-RunPatchBaseline',
      InstanceIds: [instanceId],
      Parameters: { Operation: ['Install'], RebootOption: ['NoReboot'] },
      Comment: `ops-dashboard patch-scheduler: auto-patch for an instance running on the schedule:start schedule`,
    })
  );
  return Command?.CommandId;
}

async function markPendingCommand(instanceId: string, commandId: string): Promise<void> {
  try {
    await ec2.send(new CreateTagsCommand({ Resources: [instanceId], Tags: [{ Key: LAST_PATCH_COMMAND_ID_TAG_KEY, Value: commandId }] }));
  } catch (err) {
    logger.error(`patch-scheduler: failed to write the command-id tag for ${instanceId}`, err);
  }
}

export interface PatchSchedulerResult {
  ok: true;
  patched: number;
  failed: number;
  verified: number;
  verifyFailed: number;
  scheduledRunningTotal: number;
}

export async function handler(): Promise<PatchSchedulerResult> {
  const now = new Date();
  const [candidates, ssmOnlineIds] = await Promise.all([discoverScheduledRunningInstances(), discoverSsmOnlineInstanceIds()]);

  let verified = 0;
  let verifyFailed = 0;
  const failures: PatchFailure[] = [];
  // The effective pendingCommandDate after the verify step: if a command just verify-failed, its
  // command-id tag was already cleared within this same loop -> it's treated as no longer pending,
  // eligible for patching again IMMEDIATELY within the same run (not waiting for the next run) — per
  // the spec (section 3.4, "DELETE the command-id tag (allows re-patching the same day)").
  const effectivePendingCommandId = new Map<string, string | undefined>();
  // Records the "effective" verified-date within this same run: without tracking it separately,
  // candidate.verifiedDate (read from the tag BEFORE verification) would still be undefined in the
  // eligibility step below -> an instance that just verified Success in THIS SAME run would get
  // patched again immediately, contradicting the intent that "once verified, don't patch again".
  const effectiveVerifiedDate = new Map<string, string>();

  for (const candidate of candidates) {
    if (!candidate.pendingCommandId) continue;
    if (!ssmOnlineIds.has(candidate.instanceId)) continue; // Instance offline, cannot verify — retry next run.
    try {
      const result = await verifyPendingCommand(candidate.pendingCommandId, candidate.instanceId);
      if (result.outcome === 'verified') {
        await markVerified(candidate.instanceId, now);
        verified += 1;
        effectivePendingCommandId.set(candidate.instanceId, undefined);
        effectiveVerifiedDate.set(candidate.instanceId, todayDateString(now, PATCH_TIMEZONE));
      } else if (result.outcome === 'verify-failed') {
        await clearPendingCommandTag(candidate.instanceId);
        verifyFailed += 1;
        logger.error(`patch-scheduler: patch verification FAILED for ${candidate.instanceId} (commandId=${candidate.pendingCommandId})`);
        failures.push({ displayName: candidate.displayName, stage: 'verify', reason: `SSM command ended with status ${result.status}` });
        effectivePendingCommandId.set(candidate.instanceId, undefined);
      }
      // 'still-pending': effectivePendingCommandId is not set -> the original candidate.pendingCommandId is kept below.
    } catch (err) {
      logger.error(`patch-scheduler: GetCommandInvocation failed for ${candidate.instanceId}`, err);
      failures.push({ displayName: candidate.displayName, stage: 'verify', reason: `GetCommandInvocation failed: ${(err as Error).message}` });
    }
  }

  let patched = 0;
  let failed = 0;
  for (const candidate of candidates) {
    const pendingCommandDate = effectivePendingCommandId.has(candidate.instanceId)
      ? undefined
      : candidate.pendingCommandId
        ? todayDateString(now, PATCH_TIMEZONE) // The original date of an old command-id cannot be known from the tag (the tag only stores the id) —
          // treating any surviving pending command-id as "today" is conservative in the right
          // direction: it risks a false-positive (skipping a patch that could have run), not a
          // false-negative (a duplicate patch) — an instance with a pending command-id that hasn't
          // been verified yet will not get patched again, matching the intent of avoiding duplicate commands.
        : undefined;
    const eligibilityInput: PatchEligibilityInput = {
      launchTime: candidate.launchTime,
      pendingCommandDate,
      verifiedDate: effectiveVerifiedDate.get(candidate.instanceId) ?? candidate.verifiedDate,
      ssmOnline: ssmOnlineIds.has(candidate.instanceId),
    };
    if (!isEligibleForPatch(eligibilityInput, now)) continue;
    try {
      const commandId = await sendPatchCommand(candidate.instanceId);
      if (commandId) await markPendingCommand(candidate.instanceId, commandId);
      patched += 1;
    } catch (err) {
      failed += 1;
      logger.error(`patch-scheduler: SendCommand failed for ${candidate.instanceId}`, err);
      failures.push({ displayName: candidate.displayName, stage: 'patch', reason: (err as Error).message });
    }
  }

  logger.info(`patch-scheduler: scheduledRunningTotal=${candidates.length} verified=${verified} verifyFailed=${verifyFailed} patched=${patched} failed=${failed}`);

  if (failed > 0 || verifyFailed > 0) {
    const MAX_LISTED_FAILURES = 10;
    const shown = failures.slice(0, MAX_LISTED_FAILURES);
    const remaining = failures.length - shown.length;
    const lines = shown.map((f) => `**${f.displayName}** (${f.stage}): ${f.reason}`);
    if (remaining > 0) lines.push(`… and ${remaining} more`);

    const region = process.env.AWS_REGION;
    const links = region ? [{ label: 'SSM Run Command history', url: `https://${region}.console.aws.amazon.com/systems-manager/run-command/history?region=${region}` }] : undefined;

    const embed = buildOpsNotificationEmbed({
      what: 'patch-scheduler: errors occurred in this run',
      severity: 'critical',
      who: 'system:patch-scheduler',
      impact: `${failed + verifyFailed} of ${candidates.length} scheduled instance(s) did not get a confirmed, successful patch this cycle — they carry whatever OS patch level they already had, and will only be retried on the next run.`,
      how: 'For a "patch" failure, retry next run (transient AWS errors, e.g. throttling, clear on their own). For a "verify" failure, the patch command itself did not complete successfully — check the instance in the SSM Run Command console below.',
      links,
      region,
      timestampOverride: now.toISOString(),
      extra: [
        { name: 'Patches failed', value: String(failed), inline: true },
        { name: 'Verifications failed', value: String(verifyFailed), inline: true },
        { name: 'Total scheduled instances', value: String(candidates.length), inline: true },
        ...(lines.length > 0 ? [{ name: 'Failed instances', value: lines.join('\n'), inline: false }] : []),
      ],
    });
    await postAlertEmbeds([embed]);
  }

  return { ok: true, patched, failed, verified, verifyFailed, scheduledRunningTotal: candidates.length };
}
