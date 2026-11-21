import { getEc2Client } from '../../core/aws-clients.js';
import type { AlarmSummary } from '@ops-dashboard/shared';
import { getRunbookForMetric } from '@ops-dashboard/shared';
import { getAlerts } from './alert-service.js';
import { postAlertEmbeds, type AlertEmbed, type AlertEmbedField } from './alertHook.js';
import { buildOpsNotificationEmbed, type OpsNotificationSeverity } from './opsNotification.js';
// Lean_Lambda_Exception (Requirement 6.4a): direct import, not `../ec2-management/index.js` —
// see the exception comment in `alarm-baseline-manager.ts` (same module, same reason):
// `health-report-fn` is a lean standalone Lambda and the barrel also re-exports handler files
// that pull in `config.ts` at module scope, which this Lambda is never granted the env vars for.
import { fetchEc2NameTag } from '../ec2-management/ec2NameResolver.js';
import { logger } from '../../shared-kernel/logger.js';

/**
 * `health-report.ts` — a NEW Lambda, scheduled (EventBridge Scheduler `rate(15 minutes)`, see
 * `infra/ops-dashboard.yaml`) — sends an alert embed SUMMARIZING the status of the whole system
 * every 15 minutes, REGARDLESS of whether there's a problem (requirement: "every 15 minutes send
 * a report summarizing whether the system is having any issues").
 *
 * This is a channel INDEPENDENT of `alarm-notifier.ts` (the SNS state-change subscriber)
 * — if the SNS notifier fails/misses a message (the exact bug fixed in a previous commit —
 * "problem detected" didn't show but "resolved" still did), this periodic report still catches
 * it on its own because it RE-READS the current `CloudWatch_Alarm` state via `getAlerts()`
 * (Describe_Alarms), independent of the SNS flow.
 *
 * Reuses `getAlerts()` (a single paginated `DescribeAlarms` call, already used for
 * `GET /monitoring`) instead of `get-monitoring-data.ts` (batch `GetMetricData` + surveying
 * EC2/RDS/ALB/ECS resources) — re-running that heavy pipeline every 15 minutes (96 times/day)
 * would significantly multiply CloudWatch API cost, while "problem" here only needs one signal
 * that already exists: alarm state (the same definition of "has a problem" already used by
 * `alarm-notifier.ts`/`alarm-baseline-manager.ts`).
 */

const MAX_LISTED_ALARMS = 15;

/** `AlarmSummary.relatedResourceId` is an EC2 InstanceId ONLY when it matches this shape — the
 * other resource types this dashboard supports (`DBInstanceIdentifier`, ALB name, `<cluster>/
 * <service>`) are already human-chosen names, so only this one shape is worth a Name-tag lookup.
 * Matches the id format AWS actually issues (`i-` + 8 or 17 hex chars, covering both the legacy
 * 8-char and current 17-char id lengths). */
const EC2_INSTANCE_ID_PATTERN = /^i-[0-9a-f]{8}([0-9a-f]{9})?$/;

function severityFor(hasCritical: boolean, hasWarn: boolean): OpsNotificationSeverity {
  if (hasCritical) return 'critical';
  if (hasWarn) return 'warning';
  return 'success';
}

/** Formats one alarm listing line — prioritizes showing the related resource (easier to
 * recognize) instead of just the technical alarm name, following the same principle already
 * applied in `alarm-notifier.ts`. `resourceNames` maps an EC2 InstanceId to its resolved
 * Name tag (see `handler()`'s pre-fetch below) — an id absent from the map (a lookup failure, or
 * a resourceId that was never an EC2 instance to begin with) falls back to the raw id, same
 * fallback contract every other notification composer in this project uses.
 *
 * Appends a "Next step" line (the runbook's FIRST remediation step, matching the same "most
 * important entry first" convention `formatRunbookField`/`opsNotification.ts` already rely on) —
 * WITHOUT this, a health report only ever names the alarm and leaves the reader to open the
 * dashboard/CloudWatch just to learn what it means. Only shown when `getRunbookForMetric` actually
 * resolves an entry for `alarm.metricName` (undefined for a composite alarm, a metric with no
 * catalog entry yet, or an INSUFFICIENT_DATA alarm the catalog treats as "check configuration",
 * not a metric threshold) — never fabricates guidance for a metric this project hasn't written a
 * runbook for yet. */
function formatAlarmLine(alarm: AlarmSummary, resourceNames: ReadonlyMap<string, string>): string {
  const emoji = alarm.state === 'ALARM' ? '🔴' : '🟠';
  const resolvedName = alarm.relatedResourceId ? resourceNames.get(alarm.relatedResourceId) ?? alarm.relatedResourceId : undefined;
  const resource = resolvedName ? ` (${resolvedName})` : '';
  const line = `${emoji} **${alarm.alarmName}**${resource}`;

  // Runbook guidance is only meaningful for an actual metric-threshold breach (ALARM) — an
  // INSUFFICIENT_DATA alarm's problem is missing data itself, not the metric's remediation.
  if (alarm.state !== 'ALARM' || !alarm.metricName) return line;
  const runbook = getRunbookForMetric(alarm.metricName);
  if (!runbook) return line;
  return `${line}\n   ↳ ${runbook.remediation[0]}`;
}

/** Builds the field listing non-OK alarms, truncated if it exceeds `MAX_LISTED_ALARMS` (to avoid
 * exceeding the alert embed API's 1024-character/field limit when there are many alarms) —
 * still states clearly how many more alarms aren't listed, never silently drops information. */
function buildProblemField(problemAlarms: AlarmSummary[], resourceNames: ReadonlyMap<string, string>): AlertEmbedField {
  const shown = problemAlarms.slice(0, MAX_LISTED_ALARMS);
  const lines = shown.map((alarm) => formatAlarmLine(alarm, resourceNames));
  const remaining = problemAlarms.length - shown.length;
  if (remaining > 0) lines.push(`… and ${remaining} more alarms`);
  return { name: `Alarms needing attention (${problemAlarms.length})`, value: lines.join('\n'), inline: false };
}

/**
 * Pure function — kept separate so tests don't need to mock `getAlerts()`/`postAlertEmbeds()`.
 * `resourceNames` (EC2 InstanceId -> Name tag) defaults to empty so existing/simple callers don't
 * need to pass one — `handler()` below is the one caller that actually resolves names before
 * calling this.
 */
export function buildHealthReportEmbed(alerts: AlarmSummary[], resourceNames: ReadonlyMap<string, string> = new Map()): AlertEmbed {
  const problemAlarms = alerts.filter((a) => a.threshold.level !== 'ok');
  const hasCritical = problemAlarms.some((a) => a.state === 'ALARM');
  const hasWarn = problemAlarms.some((a) => a.state === 'INSUFFICIENT_DATA');

  const extra: AlertEmbedField[] = [{ name: 'Total alarms', value: String(alerts.length), inline: true }];
  if (problemAlarms.length > 0) {
    extra.push(buildProblemField(problemAlarms, resourceNames));
  }

  // Impact is only meaningful when there's an actual ALARM (a real threshold breach) — an
  // INSUFFICIENT_DATA-only report has no confirmed consequence to state, and "All systems normal"
  // has none at all (see the file header: this is why success/info never carry a SEV tier).
  const impact = hasCritical
    ? `${problemAlarms.filter((a) => a.state === 'ALARM').length} resource(s) are actively breaching a metric threshold right now.`
    : undefined;

  // Deep-links to the SPECIFIC alarm(s) needing attention, not a generic "open CloudWatch" link —
  // per the file header's own "only link when it takes the reader directly to the relevant view"
  // rule. Every AlarmSummary already carries its own consoleLink (see alert-service.ts), so this
  // is free to build — capped at 5 to avoid an unreadably long Links field when many alarms fire
  // at once (the "Alarms needing attention" field above already lists up to MAX_LISTED_ALARMS by
  // name; Links exists for one-click access to the few most relevant, not a duplicate full list).
  const links = problemAlarms
    .slice(0, 5)
    .map((alarm) => ({ label: alarm.alarmName, url: alarm.consoleLink }))
    .filter((l) => l.url);

  return buildOpsNotificationEmbed({
    what: problemAlarms.length > 0 ? `Health Report — ${problemAlarms.length} systems need attention` : 'Health Report — All systems normal',
    severity: severityFor(hasCritical, hasWarn),
    who: 'system:health-report',
    impact,
    links: links.length > 0 ? links : undefined,
    footer: 'ops-dashboard · Periodic Health Report (15 min)',
    extra,
  });
}

/**
 * Resolves every EC2 InstanceId among `alerts`' `relatedResourceId` to its Name tag — requirement:
 * "should only use resource names, not ids, since they're hard to read", applied consistently
 * with `alarm-notifier.ts` (the same InstanceId shows the SAME name in both channels).
 * Looked up only ONCE per unique instance id (not once per alarm — several alarms commonly share
 * one instance, e.g. CPU + StatusCheckFailed), and only for alarms that actually need attention
 * (an `ok` alarm's resource name is never shown, no need to spend a DescribeInstances call on it).
 * Never throws: `fetchEc2NameTag` already swallows its own errors and falls back to `undefined`.
 */
async function resolveEc2ResourceNames(alerts: AlarmSummary[]): Promise<Map<string, string>> {
  const instanceIds = new Set(
    alerts
      .filter((a) => a.threshold.level !== 'ok')
      .map((a) => a.relatedResourceId)
      .filter((id): id is string => Boolean(id) && EC2_INSTANCE_ID_PATTERN.test(id as string)),
  );

  const resolved = new Map<string, string>();
  await Promise.all(
    [...instanceIds].map(async (instanceId) => {
      const name = await fetchEc2NameTag(getEc2Client(), instanceId);
      if (name) resolved.set(instanceId, name);
    }),
  );
  return resolved;
}

export async function handler(): Promise<{ ok: true; problemCount: number }> {
  const alerts = await getAlerts();
  const resourceNames = await resolveEc2ResourceNames(alerts);
  const embed = buildHealthReportEmbed(alerts, resourceNames);
  // Log-only (RT-0490): every ALARM transition already opens its own hub incident through
  // alarm-notifier, and a hub incident stays open until settled. Posting this 15-minute summary
  // would open a duplicate incident on every run while a problem persists.
  await postAlertEmbeds([embed], { logOnly: true });

  const problemCount = alerts.filter((a) => a.threshold.level !== 'ok').length;
  logger.info(`health-report: periodic report sent — ${problemCount}/${alerts.length} alarms need attention.`);
  return { ok: true, problemCount };
}
