import type { RecommendationItem } from '@ops-dashboard/shared';
import { getRunbookForFinding } from '@ops-dashboard/shared';
// Lean_Lambda_Exception (Requirement 6.4a): direct import, not `../../cost/index.js` — see the
// exception comment in `assessment-report-builder.ts` (same module, same reason).
import { sumEstimatedMonthlySavings } from '../../cost/costReporting.js';
// Lean_Lambda_Exception (Requirement 6.4a): direct imports, not `../../alerting/index.js` — see
// the exception comment in `assessment-report-builder.ts` (same module, same reason).
import { type DiscordEmbed } from '../../alerting/discordWebhook.js';
import { buildOpsNotificationEmbed } from '../../alerting/opsNotification.js';
// Lean_Lambda_Exception (Requirement 6.4a): direct import, not `../../governance/index.js` — see
// the exception comment in `assessment-report-builder.ts` (same module, same reason):
// `infra-review-collector-fn` is a lean standalone Lambda and the governance barrel re-exports
// `s3PolicyStore.ts`, which imports `../assessment/index.js`, which pulls in `config.ts` at
// module scope.
import { NO_AUTO_RIGHTSIZE_TAG_KEY } from '../../governance/ec2AutoRightsizing.js';

export function buildNewFindingsEmbed(newFindings: RecommendationItem[]): DiscordEmbed {
  const totalSavingsUsd = sumEstimatedMonthlySavings(newFindings);
  const fmt = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

  const fields = newFindings.slice(0, 10).map((item) => {
    // Every RecommendationFindingType has a runbook (RUNBOOK_BY_FINDING is total, see
    // shared/src/runbookCatalog.ts) — the FIRST diagnosis step is included (not remediation/
    // escalation like `formatRunbookField`) because a brand-new finding's most useful next
    // action is confirming it's real, not acting on it yet (requirement: this is a proactive
    // "heads up" notification, not a "do this now" one — the dashboard's own Runbook button
    // covers the full symptom/diagnosis/remediation/escalation detail).
    const runbook = getRunbookForFinding(item.findingType);
    const firstDiagnosisStep = runbook.diagnosis[0];
    return {
      name: `${item.resourceName} (${item.category})`,
      value: `${item.currentState}\n**Recommendation:** ${item.recommendedAction}${
        item.estimatedMonthlySavingsUsd !== null ? `\n**Estimated savings:** ${fmt(item.estimatedMonthlySavingsUsd)}/month` : ''
      }\n**Runbook (${runbook.title}) — first check:** ${firstDiagnosisStep}`,
      inline: false,
    };
  });

  return buildOpsNotificationEmbed({
    what: `${newFindings.length} NEW high-priority recommendations detected`,
    severity: 'warning',
    who: 'system:infra-review-collector',
    impact:
      totalSavingsUsd > 0
        ? `${fmt(totalSavingsUsd)}/month in identified savings is sitting unaddressed until these findings are reviewed and actioned.`
        : `${newFindings.length} new high-priority finding(s) have no $ estimate attached, but still represent a real operational risk left unaddressed (see each finding's own runbook below).`,
    why:
      totalSavingsUsd > 0
        ? `Total estimated savings (only findings with a $ estimate): ${fmt(totalSavingsUsd)}/month`
        : undefined,
    footer: 'ops-dashboard · Assessment / Recommendation',
    extra: fields,
  });
}

/** Discord Embed announcing that an instance was NEWLY added to the auto-rightsize queue —
 * shown BEFORE the real change happens (the real change only occurs the next time the instance
 * stops, performed by `ec2-rightsize-applier.ts`), giving the operator a chance to set the
 * exempt tag (`NO_AUTO_RIGHTSIZE_TAG_KEY`) if they disagree before the type change actually
 * happens. */
/** The queue direction maps to an EXISTING `RecommendationFindingType` runbook — 'down' is the
 * same "oversized" condition `ec2LowCpu` documents, 'up' is the same "AWS Compute Optimizer
 * confirms underprovisioned" condition `ec2Underprovisioned` documents. Reusing those runbooks
 * (rather than writing separate ad-hoc guidance here) means the dashboard's own Runbook drawer and
 * this Discord notification always agree on the escalation condition. */
function runbookFindingTypeForDirection(direction: 'up' | 'down'): 'ec2Underprovisioned' | 'ec2LowCpu' {
  return direction === 'up' ? 'ec2Underprovisioned' : 'ec2LowCpu';
}

export function buildAutoRightsizeQueuedEmbed(items: { instanceId: string; name: string; direction: 'up' | 'down' }[]): DiscordEmbed {
  const fields = items.slice(0, 10).map((item) => {
    const runbook = getRunbookForFinding(runbookFindingTypeForDirection(item.direction));
    const action =
      item.direction === 'up'
        ? 'AWS Compute Optimizer confirms UNDER-provisioned — will INCREASE size by 1 tier at the next stop (per the on/off schedule).'
        : 'AWS Compute Optimizer confirms OVER-provisioned — will DECREASE size by 1 tier at the next stop (per the on/off schedule).';
    return {
      // `name` empty or the sentinel '(no Name tag)' (see ec2-collector.ts) -> fall back to the raw
      // InstanceId, matching the requirement "should use the name... not the id" while still
      // giving a clue when there's no name.
      name: item.name && item.name !== '(no Name tag)' ? item.name : item.instanceId,
      value: `${action}\n**Escalate if:** ${runbook.escalateWhen[0]}`,
      inline: false,
    };
  });

  const region = process.env.AWS_REGION;
  const links = region
    ? items.slice(0, 5).map((item) => ({
        label: item.name && item.name !== '(no Name tag)' ? item.name : item.instanceId,
        url: `https://${region}.console.aws.amazon.com/ec2/home?region=${region}#InstanceDetails:instanceId=${item.instanceId}`,
      }))
    : undefined;

  return buildOpsNotificationEmbed({
    what: `${items.length} EC2 instances added to the auto-rightsize queue`,
    severity: 'info',
    who: 'system:infra-review-collector',
    why: `The InstanceType change will apply the next time the instance stops (per its existing on/off schedule), WITHOUT forcing an unplanned stop/restart. Attach the \`${NO_AUTO_RIGHTSIZE_TAG_KEY}\` tag to the instance to exclude it.`,
    links,
    region,
    footer: 'ops-dashboard · EC2_AutoRightsize',
    extra: fields,
  });
}
