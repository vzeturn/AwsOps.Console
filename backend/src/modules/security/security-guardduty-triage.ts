import { DescribeTagsCommand } from '@aws-sdk/client-ec2';
import { ListDetectorsCommand, ArchiveFindingsCommand } from '@aws-sdk/client-guardduty';
import { getEc2Client, getGuardDutyClient } from '../../core/aws-clients.js';
// Lean_Lambda_Exception (Requirement 6.4a): direct imports, not `../alerting/index.js` — see the
// exception comment in `agent/ai-ops-agent.ts` (same reason): `security-guardduty-triage-fn` is a
// lean standalone Lambda.
import { postDiscordEmbeds } from '../alerting/discordWebhook.js';
import { buildOpsNotificationEmbed } from '../alerting/opsNotification.js';
import { logger } from '../../shared-kernel/logger.js';

/**
 * `security-guardduty-triage.ts` — a NEW Lambda, triggered directly by the SAME `GuardDutyFindingsRule`
 * EventBridge Rule that already forwards findings to `AlarmNotificationTopic` (see
 * `infra/ops-dashboard.yaml` — this Lambda is a SECOND target on that rule, not a replacement for
 * the existing Discord forwarding path).
 *
 * WHAT THIS AUTOMATES
 *
 * On 2026-09-17, 3 GuardDuty findings (`DefenseEvasion:EC2/UnusualDoHActivity`,
 * `UnusualDoTActivity`, `UnusualDNSResolver`) were manually investigated, confirmed to be caused
 * by a SANCTIONED dual-VPN test (Tailscale + Netbird) on 2 specific EC2 instances, tagged
 * `SecurityException=dual-vpn-tailscale-netbird-test` on those 2 instances, and archived by hand
 * via `aws guardduty archive-findings` + a manually-created suppression filter. This Lambda turns
 * that triage step into an automatic one: a NEW finding on a resource that ALREADY carries a
 * `SecurityException` tag is auto-archived (no manual `archive-findings` call needed every time
 * the sanctioned activity re-triggers GuardDuty); a finding on a resource WITHOUT that tag is left
 * untouched (still delivered to Discord by the existing `GuardDutyFindingsRule` -> `AlarmNotificationTopic`
 * path) so a genuinely new/unexplained finding is never silently dropped.
 *
 * WHY TAG-BASED, NOT A HARDCODED FINDING-TYPE/INSTANCE-ID SUPPRESSION FILTER
 *
 * A GuardDuty suppression filter (like the one created by hand for the VPN case) is a MATCHING
 * RULE, disconnected from WHY the exception exists — reading it later tells you nothing about who
 * approved it or when it should be reviewed. Checking the resource's own tags instead means the
 * justification (`SecurityException` value, `SecurityExceptionOwner`, `SecurityExceptionReviewDate`
 * — see `governance-exemption-auditor.ts`, which audits exactly these tags for staleness) travels
 * WITH the resource, in the one place an operator already looks (`aws ec2 describe-tags`), and
 * a new resource getting the SAME sanctioned exception automatically inherits the suppression the
 * moment it's tagged — no separate filter to remember to update.
 *
 * SCOPE: only archives when a `SecurityException` tag is found — never based on finding
 * type/severity alone. A resource with no tag ALWAYS surfaces normally, regardless of how noisy
 * or benign the finding might look, per the same "never suppress by category, only by an explicit
 * per-resource decision" principle `alarm-baseline-manager.ts`'s `ALARM_BASELINE_EXCLUDED_RESOURCES`
 * and the manually-created GuardDuty filter both already follow.
 */

const ec2 = getEc2Client();
const guardduty = getGuardDutyClient();

/** The tag key that marks a resource as having a reviewed, sanctioned exception — same key
 * `governance-exemption-auditor.ts` reads for staleness. Presence alone is enough here (value is
 * shown in the Discord embed for context, not matched against). */
const SECURITY_EXCEPTION_TAG_KEY = 'SecurityException';

/** The subset of the EventBridge "GuardDuty Finding" event this Lambda actually reads — mirrors
 * `GuardDutyFindingSnsMessage['detail']` in `discord-alarm-notifier.ts` (same event shape, this
 * Lambda is a second target on the same rule, not a second event format). */
export interface GuardDutyFindingEventDetail {
  id: string;
  type: string;
  title?: string;
  severity: number;
  resource?: {
    resourceType?: string;
    instanceDetails?: { instanceId?: string };
    // GuardDuty's own ALB-related resource shapes are inconsistent across finding types, but the
    // only ALB-adjacent field this project's own findings have used so far is an ENI's associated
    // public IP -- not useful for tag lookup, so ALB findings simply fall through to "no tag
    // found" (treated the same as any other resource type this Lambda doesn't yet know how to
    // resolve an owning EC2/ALB resource for).
  };
}

export interface GuardDutyFindingEvent {
  'detail-type': string;
  source: string;
  detail: GuardDutyFindingEventDetail;
}

/** Extracts the EC2 InstanceId this finding concerns, if any — the ONLY resource type this
 * project has needed tag-based exception lookup for so far (the sanctioned VPN case). Returns
 * `undefined` for every other resource type (S3Bucket, AccessKey, ...) rather than guessing —
 * those findings are left for a human, unchanged from today's behavior. */
function extractInstanceId(detail: GuardDutyFindingEventDetail): string | undefined {
  if (detail.resource?.resourceType !== 'Instance') return undefined;
  return detail.resource.instanceDetails?.instanceId;
}

/** Looks up whether an EC2 instance carries `SecurityException` — returns the tag VALUE (for
 * context in the Discord embed) when present, `undefined` otherwise. Never throws: a lookup
 * failure (deleted instance, transient API error) is treated as "no exception found", the
 * fail-safe direction (leaves the finding to the existing normal alerting path rather than
 * auto-archiving on an unverified assumption). */
async function lookupInstanceExceptionTag(instanceId: string): Promise<string | undefined> {
  try {
    const { Tags = [] } = await ec2.send(
      new DescribeTagsCommand({ Filters: [{ Name: 'resource-id', Values: [instanceId] }, { Name: 'key', Values: [SECURITY_EXCEPTION_TAG_KEY] }] }),
    );
    return Tags[0]?.Value;
  } catch (err) {
    logger.error(`security-guardduty-triage: failed to read tags for instance ${instanceId} (treating as no exception)`, err);
    return undefined;
  }
}

/** Looks up the FIRST detector id in the account — `ArchiveFindingsCommand` requires one, and
 * this account/stack only ever has exactly 1 (see the file-header comment on `GuardDutyFindingsRule`
 * in ops-dashboard.yaml: "GuardDuty findings are account-wide regardless of which detector
 * produced them"). Returns `undefined` if GuardDuty somehow has no detector at all (should not
 * happen if a Finding event fired in the first place, but fail-safe rather than throw). */
async function lookupDetectorId(): Promise<string | undefined> {
  const { DetectorIds = [] } = await guardduty.send(new ListDetectorsCommand({}));
  return DetectorIds[0];
}

export interface TriageDecision {
  action: 'archived' | 'left-for-review';
  exceptionTagValue?: string;
}

export async function handler(event: GuardDutyFindingEvent): Promise<TriageDecision> {
  const { detail } = event;
  const instanceId = extractInstanceId(detail);

  const exceptionTagValue = instanceId ? await lookupInstanceExceptionTag(instanceId) : undefined;

  if (!exceptionTagValue) {
    logger.info(`security-guardduty-triage: finding ${detail.id} (${detail.type}) has no matching SecurityException tag — left for normal Discord alerting.`);
    return { action: 'left-for-review' };
  }

  const detectorId = await lookupDetectorId();
  if (!detectorId) {
    logger.error('security-guardduty-triage: no GuardDuty detector found — cannot archive, leaving for manual review.');
    return { action: 'left-for-review', exceptionTagValue };
  }

  await guardduty.send(new ArchiveFindingsCommand({ DetectorId: detectorId, FindingIds: [detail.id] }));
  logger.info(`security-guardduty-triage: auto-archived finding ${detail.id} (${detail.type}) on ${instanceId} — SecurityException="${exceptionTagValue}"`);

  const region = process.env.AWS_REGION;
  const embed = buildOpsNotificationEmbed({
    what: `GuardDuty finding auto-archived: ${detail.title ?? detail.type}`,
    severity: 'info',
    who: 'system:security-guardduty-triage',
    where: instanceId,
    why: `Matches an existing SecurityException tag ("${exceptionTagValue}") on the affected resource — this is expected, sanctioned activity, not a new incident.`,
    how: 'No action needed. If this exception is no longer valid, remove the SecurityException tag so future findings surface normally.',
    links: region ? [{ label: 'Open in GuardDuty', url: `https://${region}.console.aws.amazon.com/guardduty/home?region=${region}#/findings?search=id%3D${detail.id}` }] : undefined,
    region,
    resourceArn: instanceId,
    extra: [{ name: 'Finding type', value: `\`${detail.type}\``, inline: true }],
  });
  await postDiscordEmbeds([embed]);

  return { action: 'archived', exceptionTagValue };
}
