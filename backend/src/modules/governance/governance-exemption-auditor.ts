import { DescribeInstancesCommand } from '@aws-sdk/client-ec2';
import { DescribeLoadBalancersCommand, DescribeTagsCommand } from '@aws-sdk/client-elastic-load-balancing-v2';
import { getEc2Client, getElasticLoadBalancingV2Client } from '../../core/aws-clients.js';
import { getTagValue } from '../../core/awsTags.js';
import { fetchAllPages } from '../../core/pagination.js';
// Lean_Lambda_Exception (Requirement 6.4a): direct import, not `../ec2-management/index.js` —
// see the exception comment in `ec2AutoRightsizing.ts` (same module, same reason):
// `governance-exemption-auditor-fn` is a lean standalone Lambda and the barrel re-exports handler
// files that pull in `config.ts` at module scope.
import { MONITORING_EXEMPT_TAG_KEY } from '../ec2-management/thresholds.js';
// Lean_Lambda_Exception (Requirement 6.4a): direct imports, not `../alerting/index.js` — see the
// exception comment in `agent/ai-ops-agent.ts` (same reason):
// `governance-exemption-auditor-fn` is a lean standalone Lambda.
import { postDiscordEmbeds } from '../alerting/discordWebhook.js';
import { buildOpsNotificationEmbed } from '../alerting/opsNotification.js';
import { logger } from '../../shared-kernel/logger.js';

/**
 * `governance-exemption-auditor.ts` — a NEW Lambda, scheduled (EventBridge Scheduler
 * `rate(1 day)`, see `infra/ops-dashboard.yaml`).
 *
 * WHAT THIS AUTOMATES
 *
 * On 2026-09-17, 6 resources (5 EC2 instances deliberately left `stopped`, 1 STG ALB whose targets
 * go unhealthy only because the idle-to-zero scheduler stopped the app instance behind it) were
 * tagged `ops-dashboard:monitoring-exempt=true` (see `applyMonitoringExemption` in `modules/ec2-management/thresholds.ts`)
 * to stop them showing as false-positive `critical` on the Infra Map. Separately, 2 EC2 instances
 * were tagged `SecurityException=dual-vpn-tailscale-netbird-test` with a `SecurityExceptionReviewDate=
 * 2026-10-17` to document a sanctioned-but-temporary VPN test (see `security-guardduty-triage.ts`).
 *
 * Both are DELIBERATELY reversible, temporary exceptions — but a tag, once set, sits there forever
 * unless someone remembers to go back and check it. This Lambda is that "someone": it re-reads
 * every resource carrying either exemption tag, and if a `SecurityExceptionReviewDate` has already
 * passed, sends a Discord reminder instead of letting the exception silently outlive its intended
 * lifetime — the exact "forgotten monitoring exclusion" risk `alarm-baseline-manager.ts`'s own
 * `ALARM_BASELINE_EXCLUDED_RESOURCES` comment already calls out for its OWN exclusion list ("an
 * exclusion can be forgotten, and forgotten monitoring is exactly how the disk incidents earlier
 * went unnoticed").
 *
 * SCOPE: EC2 instances + ALBs — the 2 resource types `ops-dashboard:monitoring-exempt`/
 * `SecurityException*` have actually been applied to so far (see `infra-service.ts`'s
 * `applyMonitoringExemption` call sites). Extend here if a future exemption is applied to RDS/ECS.
 *
 * `ops-dashboard:monitoring-exempt` itself has NO review date requirement — it is a standing
 * statement ("this resource's stopped/unhealthy state is permanent/by-design", e.g. a seasonal
 * campaign server), not a temporary exception, so only resources that ALSO carry
 * `SecurityExceptionReviewDate` are checked for staleness. A `monitoring-exempt` tag with no
 * review date is intentionally left alone — flagging it would be inventing an expectation nobody
 * asked for.
 */

const ec2 = getEc2Client();
const elb = getElasticLoadBalancingV2Client();

const SECURITY_EXCEPTION_REVIEW_DATE_TAG_KEY = 'SecurityExceptionReviewDate';
const SECURITY_EXCEPTION_TAG_KEY = 'SecurityException';
const SECURITY_EXCEPTION_OWNER_TAG_KEY = 'SecurityExceptionOwner';

export interface ExemptedResource {
  resourceId: string;
  resourceType: 'ec2' | 'alb';
  monitoringExempt: boolean;
  securityException: string | undefined;
  securityExceptionOwner: string | undefined;
  /** ISO date string (YYYY-MM-DD), or `undefined` if the resource has no review date tag at all —
   * see the file-header comment on why that case is never flagged. */
  reviewDate: string | undefined;
}

/** Parses `reviewDate` (YYYY-MM-DD, matching how `governance-exemption-auditor`'s own tagging
 * convention was applied — e.g. `2026-10-17`) and compares against `now`. An unparseable date is
 * treated as "not overdue" (fail-safe: never invent an alert from a malformed tag value someone
 * will have to decode from a false-positive Discord message). */
export function isReviewOverdue(reviewDate: string | undefined, now: Date): boolean {
  if (!reviewDate) return false;
  const parsed = new Date(`${reviewDate}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.getTime() < now.getTime();
}

/** Pure filter — the resources from `scanEc2`/`scanAlb` that carry an OVERDUE `SecurityExceptionReviewDate`.
 * Kept separate from `handler()` so it's testable without mocking the AWS SDK. */
export function findOverdueExemptions(resources: ExemptedResource[], now: Date): ExemptedResource[] {
  return resources.filter((r) => isReviewOverdue(r.reviewDate, now));
}

async function scanEc2(): Promise<ExemptedResource[]> {
  const result: ExemptedResource[] = [];
  const reservations = await fetchAllPages(async (nextToken) => {
    const { Reservations = [], NextToken } = await ec2.send(new DescribeInstancesCommand({ NextToken: nextToken }));
    return { items: Reservations, nextToken: NextToken };
  });

  for (const reservation of reservations) {
    for (const instance of reservation.Instances ?? []) {
      const instanceId = instance.InstanceId;
      if (!instanceId) continue;
      const tags = instance.Tags ?? [];
      const monitoringExempt = tags.some((t) => t.Key === MONITORING_EXEMPT_TAG_KEY);
      const securityException = getTagValue(tags, SECURITY_EXCEPTION_TAG_KEY);
      // Only worth tracking a resource here if it carries at least one of the 2 exemption
      // mechanisms — an instance with neither tag has nothing for this Lambda to audit.
      if (!monitoringExempt && !securityException) continue;
      result.push({
        resourceId: instanceId,
        resourceType: 'ec2',
        monitoringExempt,
        securityException,
        securityExceptionOwner: getTagValue(tags, SECURITY_EXCEPTION_OWNER_TAG_KEY),
        reviewDate: getTagValue(tags, SECURITY_EXCEPTION_REVIEW_DATE_TAG_KEY),
      });
    }
  }
  return result;
}

async function scanAlb(): Promise<ExemptedResource[]> {
  const { LoadBalancers = [] } = await elb.send(new DescribeLoadBalancersCommand({}));
  const result: ExemptedResource[] = [];

  for (const lb of LoadBalancers) {
    if (!lb.LoadBalancerArn || !lb.LoadBalancerName) continue;
    let tags: { Key?: string; Value?: string }[];
    try {
      const { TagDescriptions = [] } = await elb.send(new DescribeTagsCommand({ ResourceArns: [lb.LoadBalancerArn] }));
      tags = TagDescriptions[0]?.Tags ?? [];
    } catch (err) {
      logger.error(`governance-exemption-auditor: failed to read tags for ALB ${lb.LoadBalancerName} (skipping)`, err);
      continue;
    }

    const monitoringExempt = tags.some((t) => t.Key === MONITORING_EXEMPT_TAG_KEY);
    const securityException = getTagValue(tags, SECURITY_EXCEPTION_TAG_KEY);
    if (!monitoringExempt && !securityException) continue;
    result.push({
      resourceId: lb.LoadBalancerName,
      resourceType: 'alb',
      monitoringExempt,
      securityException,
      securityExceptionOwner: getTagValue(tags, SECURITY_EXCEPTION_OWNER_TAG_KEY),
      reviewDate: getTagValue(tags, SECURITY_EXCEPTION_REVIEW_DATE_TAG_KEY),
    });
  }
  return result;
}

function formatResourceLine(resource: ExemptedResource): string {
  const kind = resource.resourceType === 'ec2' ? 'EC2' : 'ALB';
  const owner = resource.securityExceptionOwner ? ` — owner: ${resource.securityExceptionOwner}` : '';
  return `**${kind} ${resource.resourceId}** (review date: ${resource.reviewDate}${owner})`;
}

export async function handler(): Promise<{ ok: true; exempted: number; overdue: number }> {
  const now = new Date();
  const [ec2Resources, albResources] = await Promise.all([scanEc2(), scanAlb()]);
  const allExempted = [...ec2Resources, ...albResources];
  const overdue = findOverdueExemptions(allExempted, now);

  logger.info(`governance-exemption-auditor: exempted=${allExempted.length} overdue=${overdue.length}`);

  if (overdue.length > 0) {
    const region = process.env.AWS_REGION;
    // Deep-links to the exact resource's console page — an EC2 instance and an ALB use different
    // console URL shapes, so branch per resourceType rather than a generic search link. Capped at 5.
    const links = region
      ? overdue.slice(0, 5).map((r) =>
          r.resourceType === 'ec2'
            ? { label: r.resourceId, url: `https://${region}.console.aws.amazon.com/ec2/home?region=${region}#InstanceDetails:instanceId=${r.resourceId}` }
            : { label: r.resourceId, url: `https://${region}.console.aws.amazon.com/ec2/home?region=${region}#LoadBalancer:loadBalancerName=${r.resourceId}` },
        )
      : undefined;

    const embed = buildOpsNotificationEmbed({
      what: `${overdue.length} security/monitoring exception(s) are past their review date`,
      severity: 'warning',
      who: 'system:governance-exemption-auditor',
      impact: `${overdue.length} resource(s) are running with a security/monitoring exception that nobody has re-confirmed is still needed — if the underlying reason no longer applies, the exception is now masking a real risk instead of documenting a reviewed one.`,
      why: 'These resources carry a SecurityException tag with a review date that has already passed — nobody has re-confirmed the exception is still needed.',
      how: 'Re-confirm the exception is still valid and update SecurityExceptionReviewDate, or remove the exception tags if it has concluded.',
      links,
      region,
      extra: [
        {
          name: 'Overdue exceptions',
          value: overdue.map(formatResourceLine).join('\n').slice(0, 1024),
          inline: false,
        },
      ],
    });
    await postDiscordEmbeds([embed]);
  }

  return { ok: true, exempted: allExempted.length, overdue: overdue.length };
}
