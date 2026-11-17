import { randomUUID } from 'node:crypto';
import type { EventBridgeEvent } from 'aws-lambda';
import { DescribeInstancesCommand, ModifyInstanceAttributeCommand, CreateTagsCommand, DeleteTagsCommand } from '@aws-sdk/client-ec2';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getEc2Client, getS3Client } from '../../core/aws-clients.js';
import type { ActionAuditRecord } from '@ops-dashboard/shared';
import {
  areArchitecturesCompatible,
  computeEc2RightsizeTargetInDirection,
  fetchInstanceTypeArchitectures,
} from './ec2Rightsizing.js';
import { NO_AUTO_RIGHTSIZE_TAG_KEY, PENDING_AUTO_RIGHTSIZE_TAG_KEY, LAST_AUTO_RIGHTSIZE_DATE_TAG_KEY, todayDateString, pickSafeCrossFamilyRecommendation, classifyComputeOptimizerDirection } from './ec2AutoRightsizing.js';
// Lean_Lambda_Exception (Requirement 6.4a): direct import, not `../infra/index.js` — see the
// exception comment in `ec2AutoRightsizing.ts` (same module, same reason):
// `ec2-rightsize-applier-fn` is a lean standalone Lambda and the infra barrel re-exports
// `get-infra.ts`/`get-topology.ts`, which pull in `config.ts` at module scope.
import { fetchEc2RecommendationDetail } from '../infra/compute-optimizer-collector.js';
// Lean_Lambda_Exception (Requirement 6.4a): direct imports, not `../alerting/index.js` — see the
// exception comment in `agent/ai-ops-agent.ts` (same reason): `ec2-rightsize-applier-fn` is a
// lean standalone Lambda.
import { postDiscordEmbeds } from '../alerting/discordWebhook.js';
import { buildOpsNotificationEmbed, type OpsNotificationSeverity } from '../alerting/opsNotification.js';
import { logger } from '../../shared-kernel/logger.js';

/** The AWS Account ID of the account deploying this stack (CloudFormation pseudo-param
 * `${AWS::AccountId}` — see `infra/ops-dashboard.yaml`) — NEVER hardcoded, same pattern as
 * `infra-review-collector.ts`/`backup-vault-protection-action-service.ts`. */
const AWS_ACCOUNT_ID = process.env.AWS_ACCOUNT_ID;
if (!AWS_ACCOUNT_ID) throw new Error('Missing required environment variable: AWS_ACCOUNT_ID');

/**
 * `ec2-rightsize-applier.ts` — a NEW Lambda, triggered by the EventBridge Rule "EC2 Instance
 * State-change Notification" (source `aws.ec2`, see `infra/ops-dashboard.yaml`,
 * `Ec2RightsizeApplierRule`) whenever ANY EC2 instance in the account transitions to the `stopped`
 * state. This is the EXECUTION half of the `EC2_AutoRightsize` mechanism — the EVALUATION half
 * (`evaluateAutoRightsizeCandidates`, which only sets/clears tags, never mutates) lives in
 * `infra-review-collector.ts`; see `lib/ec2AutoRightsizing.ts` for the full design comments/reasons
 * for splitting into two phases.
 *
 * FLOW: reads the instance's `PENDING_AUTO_RIGHTSIZE_TAG_KEY` tag RIGHT WHEN the event is received
 * (the instance has already fully stopped — EventBridge state-change is only sent AFTER the
 * instance has transitioned state, not while transitioning) — if this tag is absent, skip
 * IMMEDIATELY (the instance stopped for another reason, unrelated to this mechanism; the vast
 * majority of calls to this Lambda fall into this branch, since EVERY EC2 instance stop in the
 * account triggers the event, not just instances awaiting rightsize). If the pending tag exists:
 * RECOMPUTE the target instance type + check REAL CPU architecture compatibility at this exact
 * moment (never trust data the evaluator computed earlier — could be hours/days old), then call
 * `ModifyInstanceAttribute`. Does NOT restart the instance itself after the change — the external
 * on/off schedule system will turn it back on at its normal time (this IS "the next reboot" from
 * the original requirement).
 *
 * Whether it succeeds or fails, ALWAYS clears the pending tag right after processing (to avoid
 * reapplying multiple times if the instance stops/starts several times in a day before the
 * evaluator runs again) — the evaluator's next run will re-evaluate on its own and create a new
 * tag if Compute Optimizer still confirms a rightsize is needed.
 */

const AWS_REGION = process.env.AWS_REGION as string;
const ASSESSMENT_BUCKET_NAME = process.env.ASSESSMENT_BUCKET_NAME;
if (!ASSESSMENT_BUCKET_NAME) throw new Error('Missing required environment variable: ASSESSMENT_BUCKET_NAME');

const ec2 = getEc2Client();
const s3 = getS3Client();

/** The real payload of the EventBridge "EC2 Instance State-change Notification" (source `aws.ec2`)
 * — only declares the 2 fields needed (see AWS docs "State change events for Amazon EC2
 * instances"). */
interface Ec2StateChangeDetail {
  'instance-id': string;
  state: string;
}

/** Writes one `Action_Audit_Record` — shares the same S3 key/prefix convention as
 * `action-audit-service.ts` (`action-audit/ec2-instance-<instanceId>/<executedAt>-<actionId>.json`)
 * BUT implements it independently here (does not import `action-audit-service.ts`, since that file
 * depends on `config.ts` — a singleton module that validates the ENTIRE `AppConfig`, unrelated to
 * this minimal Lambda, following the same least-privilege principle already applied to
 * `cost-collector.ts`/`infra-review-collector.ts`). Never throws — an audit-write error must not
 * block or affect the main processing result.
 */
async function writeAuditRecordMinimal(record: ActionAuditRecord): Promise<void> {
  const key = `action-audit/ec2-instance-${record.resource.id}/${record.executedAt}-${randomUUID()}.json`;
  try {
    await s3.send(
      new PutObjectCommand({ Bucket: ASSESSMENT_BUCKET_NAME, Key: key, Body: JSON.stringify(record), ContentType: 'application/json' }),
    );
  } catch (err) {
    logger.error(`ec2-rightsize-applier: writing Action_Audit_Record failed (ignored, not thrown), key=${key}`, err);
  }
}

interface ResolvedRightsizeTarget {
  instanceType: string;
  currentArchitectures: string[];
  targetArchitectures: string[];
  /** `'computeOptimizer'` when applying EXACTLY the instance type Compute Optimizer recommended
   * (rank 1, may be from a DIFFERENT family — only when AWS confirms `migrationEffort: 'VeryLow'`
   * + no platformDifferences, see `pickSafeCrossFamilyRecommendation`). `'sameFamily'` when falling
   * back to increasing/decreasing one step within the CURRENT family (Compute Optimizer has no
   * "clean" recommendation, or no longer confirms this direction at apply time). Used to record
   * clearly in the audit trail/Discord notification. */
  source: 'computeOptimizer' | 'sameFamily';
}

/**
 * Determines the REAL target instance type at apply time — PRIORITIZES Compute Optimizer's DIRECT
 * recommendation (which may move the instance to a different family with better
 * performance/pricing for that workload — meeting the requirement "whichever family is more
 * optimal should be applied") IF AND ONLY IF AWS confirms this is a safe architecture change
 * (`pickSafeCrossFamilyRecommendation`), then RE-VERIFIES the real CPU architecture via
 * `DescribeInstanceTypes` (defense-in-depth, never blindly trusting a single field from Compute
 * Optimizer). If any condition fails — falls back to `computeEc2RightsizeTargetInDirection()`
 * (increase/decrease one step within the SAME family, always the same CPU architecture by design,
 * see `ec2Rightsizing.ts`).
 *
 * Calls Compute Optimizer again RIGHT NOW (does not use data the evaluator tagged earlier, which
 * could be hours/days old) — if Compute Optimizer no longer confirms the EXACT `direction` awaiting
 * processing (it changed its mind), falls back to same-family RATHER THAN cancelling entirely
 * (preserves the evaluator's original intent — the evaluator's next run will adjust the tag again
 * if needed).
 */
async function resolveRightsizeTarget(
  instanceId: string,
  currentInstanceType: string,
  direction: 'up' | 'down',
): Promise<ResolvedRightsizeTarget | undefined> {
  const instanceArn = `arn:aws:ec2:${AWS_REGION}:${AWS_ACCOUNT_ID}:instance/${instanceId}`;
  const detail = await fetchEc2RecommendationDetail(instanceArn);

  const stillConfirmsDirection = detail && classifyComputeOptimizerDirection(detail.finding, detail.findingReasonCodes) === direction;
  const safeInstanceType = stillConfirmsDirection ? pickSafeCrossFamilyRecommendation(detail.topRecommendationOption) : undefined;

  if (safeInstanceType && safeInstanceType !== currentInstanceType) {
    try {
      const [currentArchitectures, targetArchitectures] = await Promise.all([
        fetchInstanceTypeArchitectures(ec2, currentInstanceType),
        fetchInstanceTypeArchitectures(ec2, safeInstanceType),
      ]);
      if (currentArchitectures && targetArchitectures && areArchitecturesCompatible(currentArchitectures, targetArchitectures)) {
        return { instanceType: safeInstanceType, currentArchitectures, targetArchitectures, source: 'computeOptimizer' };
      }
      logger.info(
        `ec2-rightsize-applier: ${instanceId} — Compute Optimizer recommended "${safeInstanceType}" but the real CPU architecture verification did NOT match (or could not be read) — falling back to same-family.`,
      );
    } catch (err) {
      logger.error(`ec2-rightsize-applier: verifying CPU architecture for Compute Optimizer recommendation "${safeInstanceType}" failed (falling back to same-family)`, err);
    }
  }

  const sameFamilyTarget = await computeEc2RightsizeTargetInDirection(ec2, currentInstanceType, direction);
  return sameFamilyTarget ? { ...sameFamilyTarget, source: 'sameFamily' } : undefined;
}

function buildResultEmbed(params: {
  instanceId: string;
  /** Display name shown in Discord (Name tag, falling back to instanceId if absent) — per the
   * requirement "should only use instance/resource names, not IDs, since they're hard to read". */
  displayName: string;
  direction: 'up' | 'down';
  outcome: 'success' | 'failure' | 'rejected';
  reason?: string;
  fromType?: string;
  toType?: string;
  source?: ResolvedRightsizeTarget['source'];
}) {
  const { instanceId, displayName, direction, outcome, reason, fromType, toType, source } = params;
  const directionLabel = direction === 'up' ? 'INCREASED' : 'DECREASED';
  const what =
    outcome === 'success' ? `Automatically ${directionLabel.toLowerCase()} size for ${displayName}` : `Automatic rightsize for ${displayName} failed`;
  const sourceNote =
    source === 'computeOptimizer'
      ? ' (direct recommendation from AWS Compute Optimizer — different family, confirmed same CPU architecture + no platform differences)'
      : '';
  const severity: OpsNotificationSeverity = outcome === 'success' ? 'success' : outcome === 'rejected' ? 'warning' : 'critical';

  // Rollback guidance ONLY for a successful change — a failure/rejection never modified the
  // instance in the first place, so "how to undo it" doesn't apply. Same-family/same-CPU-
  // architecture changes are always safely reversible by re-applying the exact opposite
  // ModifyInstanceAttribute call (matching the reasoning in runbookCatalog.ts's `ec2LowCpu`
  // entry) — stated explicitly so acting on a wrong rightsize doesn't require reading the code
  // to find out it's undoable.
  const rollback =
    outcome === 'success' && fromType && toType
      ? `Rollback: ModifyInstanceAttribute \`${displayName}\` back to \`${fromType}\` (same architecture, safe in either direction — attach the \`${NO_AUTO_RIGHTSIZE_TAG_KEY}\` tag first to prevent this from being reapplied automatically).`
      : undefined;

  // A "rejected" outcome (no consequence — the instance was never touched) has no impact to
  // state; a genuine "failure" (ModifyInstanceAttribute itself errored, or the size-list lookup
  // failed) means the instance is stuck on its ORIGINAL type — worth stating explicitly, since
  // the auto-rightsize opportunity is simply lost for this stop cycle, not silently retried.
  const impact = outcome === 'failure' ? `Rightsize for ${displayName} did not happen this cycle — it remains on \`${fromType ?? 'its current type'}\`, and the evaluator will only reconsider it on its next scheduled run.` : undefined;

  return buildOpsNotificationEmbed({
    what,
    severity,
    where: displayName,
    who: 'system:ec2-rightsize-applier',
    impact,
    why: outcome !== 'success' ? reason : undefined,
    how:
      outcome === 'success' && fromType && toType
        ? `Instance type: \`${fromType}\` → \`${toType}\`${sourceNote}. Applied when the instance stopped per the on/off schedule — will take effect on the next start.`
        : undefined,
    links: [{ label: 'Open in EC2', url: `https://${AWS_REGION}.console.aws.amazon.com/ec2/home?region=${AWS_REGION}#InstanceDetails:instanceId=${instanceId}` }],
    region: AWS_REGION,
    footer: 'ops-dashboard · EC2_AutoRightsize',
    extra: rollback ? [{ name: 'Rollback', value: rollback, inline: false }] : undefined,
  });
}

export async function handler(event: EventBridgeEvent<'EC2 Instance State-change Notification', Ec2StateChangeDetail>): Promise<void> {
  const instanceId = event.detail['instance-id'];
  const newState = event.detail.state;

  if (newState !== 'stopped') return; // Only process once the instance has FULLY stopped.

  let tags: { Key?: string; Value?: string }[];
  let currentInstanceType: string;
  try {
    const { Reservations = [] } = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
    const instance = Reservations[0]?.Instances?.[0];
    if (!instance) {
      logger.info(`ec2-rightsize-applier: instance ${instanceId} not found (terminated?), skipping.`);
      return;
    }
    tags = instance.Tags ?? [];
    currentInstanceType = instance.InstanceType ?? '';
  } catch (err) {
    logger.error(`ec2-rightsize-applier: DescribeInstances failed for ${instanceId} (skipping)`, err);
    return;
  }

  // The Name tag is already available in `tags` (DescribeInstances above) — no extra API call is
  // made just to look up the name (avoiding a redundant round-trip, see STANDARDS.md §3).
  const displayName = tags.find((t) => t.Key === 'Name')?.Value || instanceId;

  const pendingRaw = tags.find((t) => t.Key === PENDING_AUTO_RIGHTSIZE_TAG_KEY)?.Value;
  const direction = pendingRaw === 'up' || pendingRaw === 'down' ? pendingRaw : undefined;
  if (!direction) return; // This instance is not awaiting auto-rightsize — most calls fall here.

  const isExempt = tags.some((t) => t.Key === NO_AUTO_RIGHTSIZE_TAG_KEY);

  // Always clear the pending tag as soon as a processing decision is made (success/failure/
  // exempt) — the evaluator's next run will re-evaluate on its own and create a new tag if still
  // needed, avoiding reapplying multiple times if the instance stops/starts several times before
  // the evaluator runs again.
  const clearPendingTag = async (): Promise<void> => {
    try {
      await ec2.send(new DeleteTagsCommand({ Resources: [instanceId], Tags: [{ Key: PENDING_AUTO_RIGHTSIZE_TAG_KEY }] }));
    } catch (err) {
      logger.error(`ec2-rightsize-applier: clearing the pending tag failed for ${instanceId} (skipping)`, err);
    }
  };

  if (isExempt) {
    logger.info(`ec2-rightsize-applier: ${instanceId} has the ${NO_AUTO_RIGHTSIZE_TAG_KEY} tag, skipping despite the pending tag being set.`);
    await clearPendingTag();
    return;
  }

  let target: ResolvedRightsizeTarget | undefined;
  try {
    target = await resolveRightsizeTarget(instanceId, currentInstanceType, direction);
  } catch (err) {
    logger.error(`ec2-rightsize-applier: determining the target instance type failed for ${instanceId}`, err);
    await clearPendingTag();
    await postDiscordEmbeds([
      buildResultEmbed({ instanceId, displayName, direction, outcome: 'failure', reason: `Could not read the size list for the family: ${(err as Error).message}` }),
    ]);
    return;
  }

  const executedAt = new Date().toISOString();
  const baseAudit = {
    executedBy: 'system:ec2-rightsize-applier',
    executedAt,
    actionType: 'EC2_AutoRightsize' as const,
    resource: { id: instanceId, arn: `arn:aws:ec2:${AWS_REGION}:*:instance/${instanceId}`, region: AWS_REGION },
    params: { direction, currentInstanceType },
  };

  if (!target) {
    const reason = `Could not determine a safe target instance type (direction "${direction}") from "${currentInstanceType}" at stop time (already at the ${direction === 'up' ? 'largest' : 'smallest'} size in the family, or the type format is unrecognized).`;
    logger.info(`ec2-rightsize-applier: ${instanceId} — ${reason}`);
    await clearPendingTag();
    await writeAuditRecordMinimal({ ...baseAudit, outcome: 'rejected', reason });
    await postDiscordEmbeds([buildResultEmbed({ instanceId, displayName, direction, outcome: 'rejected', reason })]);
    return;
  }

  if (!areArchitecturesCompatible(target.currentArchitectures, target.targetArchitectures)) {
    const reason = `Target instance type "${target.instanceType}" is not CPU-architecture compatible with "${currentInstanceType}" (${target.currentArchitectures.join('/')} vs ${target.targetArchitectures.join('/')}) — aborting to avoid an instance that fails to start back up.`;
    logger.info(`ec2-rightsize-applier: ${instanceId} — ${reason}`);
    await clearPendingTag();
    await writeAuditRecordMinimal({ ...baseAudit, outcome: 'rejected', reason });
    await postDiscordEmbeds([buildResultEmbed({ instanceId, displayName, direction, outcome: 'rejected', reason })]);
    return;
  }

  try {
    await ec2.send(new ModifyInstanceAttributeCommand({ InstanceId: instanceId, InstanceType: { Value: target.instanceType } }));
  } catch (err) {
    const reason = `ModifyInstanceAttribute failed for ${displayName} (still on type "${currentInstanceType}"): ${(err as Error).message}`;
    logger.error(`ec2-rightsize-applier: ${reason}`);
    await clearPendingTag();
    await writeAuditRecordMinimal({ ...baseAudit, outcome: 'failure', reason });
    await postDiscordEmbeds([buildResultEmbed({ instanceId, displayName, direction, outcome: 'failure', reason })]);
    return;
  }

  await clearPendingTag();
  try {
    await ec2.send(
      new CreateTagsCommand({ Resources: [instanceId], Tags: [{ Key: LAST_AUTO_RIGHTSIZE_DATE_TAG_KEY, Value: todayDateString(new Date()) }] }),
    );
  } catch (err) {
    logger.error(`ec2-rightsize-applier: writing the cooldown tag failed for ${instanceId} (type change already succeeded, only the cooldown guard is lost — ignoring)`, err);
  }

  logger.info(
    `ec2-rightsize-applier: ${instanceId} type changed successfully ${currentInstanceType} -> ${target.instanceType} (direction ${direction}, source ${target.source}).`,
  );
  await writeAuditRecordMinimal({
    ...baseAudit,
    outcome: 'success',
    params: { direction, currentInstanceType, newInstanceType: target.instanceType, source: target.source },
  });
  await postDiscordEmbeds([
    buildResultEmbed({ instanceId, displayName, direction, outcome: 'success', fromType: currentInstanceType, toType: target.instanceType, source: target.source }),
  ]);
}
