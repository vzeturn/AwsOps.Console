import type { SNSEvent } from 'aws-lambda';
import { LookupEventsCommand, type Event as CloudTrailEvent } from '@aws-sdk/client-cloudtrail';
import { getEc2Client, getCloudTrailClient } from '../../core/aws-clients.js';
import { getRunbookForMetric } from '@ops-dashboard/shared';
import { logger } from '../../shared-kernel/logger.js';
// Lean_Lambda_Exception (Requirement 6.4a): direct import, not `../ec2-management/index.js` —
// see the exception comment in `alarm-baseline-manager.ts` (same module, same reason):
// `alerting-notifier-fn` is a lean standalone Lambda and the barrel also re-exports handler
// files that pull in `config.ts` at module scope, which this Lambda is never granted the env vars for.
import { fetchEc2NameTag, fetchNatGatewayNameTag } from '../ec2-management/ec2NameResolver.js';
import { formatRunbookField } from './runbookNotificationText.js';
import { postAlertEmbeds } from './alertHook.js';

/**
 * `alarm-notifier.ts` — a NEW Lambda, the ONLY subscriber of every CloudWatch Alarm SNS
 * topic in the `AWS_Account` (requirement: "SNS should no longer send email but switch to
 * sending via an alert hook ... nicely formatted, enterprise-grade"). Receives
 * `CloudWatch_Alarm` state-change notifications (the standard JSON payload CloudWatch sends via
 * SNS when `AlarmActions`/`OKActions` fire), reformats it into an alert embed, then POSTs it to
 * the alert hook.
 *
 * Reads the region directly from `process.env` (set automatically by the Lambda runtime),
 * following the same pattern as `cost-collector.ts`/`monitoring-service.ts` — does NOT import
 * `config.ts` (that module validates the entire `AppConfig`, which is unrelated to this Lambda).
 *
 * Delivery goes through `alertHook.ts` (the Request Tracking hub alert hook; warning/critical are
 * posted, info/OK are logged only).
 */

/** Which dimensions need name lookup instead of a raw ID — only dimensions whose value is an
 * unreadable ID (see `ec2NameResolver.ts`'s file header). Lookups are shared with
 * `health-report.ts` so the SAME `InstanceId` resolves to the SAME displayed name in every
 * notification channel — requirement: "the webhook alert only shows InstanceId, need the
 * instance name to know which service is affected". */
const NAME_LOOKUP_BY_DIMENSION: Record<string, (value: string) => Promise<string | undefined>> = {
  InstanceId: (instanceId) => fetchEc2NameTag(getEc2Client(), instanceId),
  NatGatewayId: (natGatewayId) => fetchNatGatewayNameTag(getEc2Client(), natGatewayId),
};


/** The standard JSON payload CloudWatch sends in the SNS message when a Metric_Alarm changes
 * state — lists ONLY the fields needed to format the alert embed (the real payload has more
 * fields, see the AWS docs "Amazon CloudWatch Alarm state changes"). */
interface CloudWatchAlarmSnsMessage {
  AlarmName: string;
  AlarmDescription?: string | null;
  NewStateValue: 'OK' | 'ALARM' | 'INSUFFICIENT_DATA';
  OldStateValue: 'OK' | 'ALARM' | 'INSUFFICIENT_DATA';
  NewStateReason: string;
  StateChangeTime: string;
  Region: string;
  AlarmArn: string;
  Trigger?: CloudWatchAlarmTrigger;
}

interface CloudWatchAlarmDimension {
  name: string;
  value: string;
}

interface CloudWatchAlarmTrigger {
  MetricName?: string;
  Namespace?: string;
  Dimensions?: CloudWatchAlarmDimension[];
  Threshold?: number;
  ComparisonOperator?: string;
  /** The alarm's evaluation period in SECONDS — used only by the CIS Benchmark enrichment
   * (`lookupCisBenchmarkEvent`) to size the CloudTrail lookup window around `StateChangeTime`. */
  Period?: number;
}

/**
 * The payload an RDS EVENT SUBSCRIPTION sends — a completely different shape from a CloudWatch alarm,
 * with no `AlarmName` and no `NewStateValue`. The field names really do contain spaces.
 *
 * WHY THIS LAMBDA HAS TO KNOW ABOUT IT. A CloudWatch alarm can only watch a metric, and an important
 * class of RDS problems is not a metric: storage autoscaling refusing to grow, a failed backup, a forced
 * failover, a pending forced upgrade. Those arrive only as events. Measured on abc-prod (2026-09-08)
 * there was no event subscription in the account at all, so RDS had been emitting
 * "Storage size 600 GiB is approaching the maximum storage threshold 700 GiB" every two hours for at
 * least fourteen days and it reached nobody.
 *
 * Adding the subscription (see `RdsEventSubscription` in infra/ops-dashboard.yaml) without teaching this
 * handler the shape would have been worse than not adding it: the shape check below would have logged
 * "does not match the CloudWatch Alarm shape" and dropped every event, leaving a subscription that looks
 * configured, is billed for, and delivers nothing.
 */
interface RdsEventSnsMessage {
  'Event Source': string;
  'Event Time': string;
  'Identifier Link'?: string;
  'Source ID': string;
  'Source ARN'?: string;
  'Event ID'?: string;
  'Event Message': string;
}

function isRdsEventMessage(message: unknown): message is RdsEventSnsMessage {
  if (typeof message !== 'object' || message === null) return false;
  const m = message as Record<string, unknown>;
  return typeof m['Event Message'] === 'string' && typeof m['Source ID'] === 'string';
}

/**
 * The payload published to SNS when an EventBridge Rule targets the topic DIRECTLY (no
 * `InputTransformer`) for a "GuardDuty Finding" event — the message body is the FULL EventBridge
 * event envelope, not just `detail` (see `GuardDutyFindingsRule` in infra/ops-dashboard.yaml: no
 * `InputTransformer` is configured, so this is the exact shape SNS receives and this Lambda must
 * parse). Only the fields this notifier actually reads are declared — the real GuardDuty finding
 * detail has many more (see the AWS docs "GuardDuty finding format").
 */
interface GuardDutyFindingSnsMessage {
  'detail-type': string;
  source: string;
  region: string;
  detail: {
    type: string;
    title?: string;
    description?: string;
    severity: number;
    id: string;
    region: string;
    resource?: {
      resourceType?: string;
      instanceDetails?: { instanceId?: string; tags?: { key: string; value: string }[] };
      s3BucketDetails?: { name?: string }[];
    };
  };
}

function isGuardDutyFindingMessage(message: unknown): message is GuardDutyFindingSnsMessage {
  if (typeof message !== 'object' || message === null) return false;
  const m = message as Record<string, unknown>;
  return m.source === 'aws.guardduty' && m['detail-type'] === 'GuardDuty Finding' && typeof m.detail === 'object' && m.detail !== null;
}

/**
 * GuardDuty severity is a float from 0.1 to 8.9 (NOT a fixed enum) — bucketed into the 3 named
 * tiers GuardDuty's own console/documentation uses (Low 1.0-3.9, Medium 4.0-6.9, High 7.0-8.9),
 * so the alert embed reads the same severity language an operator would see in the GuardDuty
 * console itself, rather than inventing a different scale. In practice this notifier only ever
 * receives Medium/High (the EventBridge Rule filters `severity >= 4`, see
 * `GuardDutyFindingsRule`), but the mapping stays total (covers the full range) so a future rule
 * change or a manually-sent test message never falls through with no color/label.
 */
function guardDutySeverityTier(severity: number): { label: string; color: number; emoji: string } {
  if (severity >= 7) return { label: 'HIGH', color: 0xed4245, emoji: '🔴' };
  if (severity >= 4) return { label: 'MEDIUM', color: 0xfaa61a, emoji: '🟠' };
  return { label: 'LOW', color: 0x5865f2, emoji: '🔵' };
}

/**
 * The response standard actually enforced for this account — not a generic "GuardDuty severity
 * scale" restatement, but what this project's own `GuardDutyFindingsRule` (`severity >= 4`) means
 * an operator receiving this notification should do. Keeping this text here (not just in a wiki
 * page) means the notification itself explains the standard being applied, matching every other
 * notification composer's "how" guidance.
 */
function guardDutyResponseStandard(tier: ReturnType<typeof guardDutySeverityTier>['label']): string {
  if (tier === 'HIGH') {
    return 'Treat as an active security incident — investigate immediately (do not wait for business hours) and involve whoever owns account security if the affected resource is production.';
  }
  return 'MEDIUM severity — investigate within the current business day. Confirm whether the affected resource/activity was expected (e.g. a known scan, a legitimate new deployment) before dismissing.';
}

/** Extracts the most relevant resource identifier from a GuardDuty finding's `resource` block —
 * an EC2 instance and its Name tag (same lookup already used for `InstanceId` alarm dimensions —
 * kept as a fallback here since a `GuardDutyFindingDetail` already embeds tags directly, so no
 * extra `DescribeInstances` call is needed), or an S3 bucket name. Findings the account hasn't
 * been scoped for yet (e.g. EKS/Lambda protection) fall back to the raw `resourceType`. */
function describeGuardDutyResource(resource: GuardDutyFindingSnsMessage['detail']['resource']): string {
  if (!resource) return '(unknown resource)';
  if (resource.resourceType === 'Instance' && resource.instanceDetails) {
    const nameTag = resource.instanceDetails.tags?.find((t) => t.key === 'Name')?.value;
    const instanceId = resource.instanceDetails.instanceId;
    return nameTag ? `**${nameTag}**` : instanceId ? `\`${instanceId}\`` : '(unknown EC2 instance)';
  }
  if (resource.resourceType === 'S3Bucket' && resource.s3BucketDetails?.[0]?.name) {
    return `S3 bucket \`${resource.s3BucketDetails[0].name}\``;
  }
  return resource.resourceType ?? '(unknown resource)';
}

/**
 * Builds the alert embed for a GuardDuty finding. Deliberately does NOT attempt to distinguish
 * "new" vs "recurring" findings — GuardDuty itself aggregates repeat occurrences of the same
 * finding type within a 6-hour window into ONE EventBridge event (see AWS docs "Findings
 * summary"), so by the time this notifier receives an event, GuardDuty has already done the
 * dedup — no need for a second layer of noise suppression here.
 */
/** Maps GuardDuty's own HIGH/MEDIUM/LOW tier (see `guardDutySeverityTier`) to the SAME SEV badge
 * scheme every other embed in this Lambda/`opsNotification.ts` uses — HIGH is an active security
 * incident (SEV-1, matching `guardDutyResponseStandard`'s own "treat as an active incident, do
 * not wait for business hours" text), MEDIUM is same-business-day (SEV-3), LOW carries no badge
 * (this Lambda's own EventBridge Rule filters `severity >= 4`, so LOW is only reachable via a
 * manually-sent test message, not a real finding — see the file header on `guardDutySeverityTier`). */
function guardDutySevTier(label: ReturnType<typeof guardDutySeverityTier>['label']): string | undefined {
  if (label === 'HIGH') return 'SEV-1';
  if (label === 'MEDIUM') return 'SEV-3';
  return undefined;
}

function buildGuardDutyFindingEmbed(message: GuardDutyFindingSnsMessage) {
  const { detail } = message;
  const tier = guardDutySeverityTier(detail.severity);
  const sevTier = guardDutySevTier(tier.label);

  const fields: { name: string; value: string; inline?: boolean }[] = [
    { name: 'Severity', value: `${tier.emoji} ${tier.label} (${detail.severity.toFixed(1)})`, inline: true },
    { name: 'Region', value: detail.region, inline: true },
    { name: 'Finding type', value: `\`${detail.type}\``, inline: false },
    { name: 'Affected resource', value: describeGuardDutyResource(detail.resource), inline: false },
  ];
  if (detail.description) {
    fields.push({ name: 'Description', value: detail.description, inline: false });
  }
  // Impact is only stated for a genuine security concern (HIGH/MEDIUM) — a finding this Lambda's
  // own EventBridge Rule wouldn't even forward at LOW severity has no real impact to characterize.
  if (tier.label === 'HIGH' || tier.label === 'MEDIUM') {
    fields.push({
      name: '🎯 Impact',
      value: `A ${tier.label.toLowerCase()}-severity GuardDuty finding means AWS's own threat detection has moderate-to-high confidence this reflects genuinely malicious or anomalous activity, not routine noise — left uninvestigated, this could represent an active compromise or unauthorized access already in progress.`,
      inline: false,
    });
  }
  fields.push({ name: 'Standard applied', value: guardDutyResponseStandard(tier.label), inline: false });
  fields.push({
    name: '🔗 Links',
    value: `[Open in GuardDuty](https://${message.region}.console.aws.amazon.com/guardduty/home?region=${message.region}#/findings?search=id%3D${detail.id})`,
    inline: false,
  });
  fields.push({ name: '🏷️ Metadata', value: `\`\`\`\nRegion: ${message.region}\n\`\`\``, inline: false });

  return {
    title: `${tier.emoji}${sevTier ? ` [${sevTier}]` : ''} GuardDuty · ${detail.title ?? detail.type}`,
    color: tier.color,
    fields,
    footer: { text: 'ops-dashboard · Amazon GuardDuty' },
  };
}

/**
 * Builds the alert embed for an RDS event.
 *
 * ONE COLOUR for all of them, deliberately. The obvious design would key the colour off the event
 * category the way alarm embeds key off state — but the SNS payload does NOT carry the category, only a
 * free-text message and an `Event ID` documentation link. Deriving severity by pattern-matching the
 * message text would be a guess dressed as a fact, and the guess would silently rot as AWS reworded
 * things. It is unnecessary anyway: the subscription is scoped to categories that all mean "a human
 * needs to look at this" (low storage, failure, deletion, maintenance, security patching), so amber for
 * every one of them is the accurate statement.
 */
/**
 * RDS event free-text messages don't carry a structured category (see the function comment
 * above), so the ONLY reliable way to attach the matching runbook is to recognize a SPECIFIC,
 * previously-confirmed message pattern — not a broad keyword guess that could misfire on an
 * unrelated event and point the operator at the wrong runbook. Currently covers the ONE pattern
 * this project has actually seen and confirmed matters (`abc-prod-rds-postgres`'s recurring
 * "approaching the maximum storage threshold" event, see the file-header comment) — mapped to the
 * same `FreeStorageSpace` runbook the dashboard's own metric panel uses, so the guidance never
 * diverges between the two channels. Returns `undefined` for any message that doesn't match a
 * known pattern, rather than guessing.
 */
function inferRdsEventRunbook(eventMessage: string) {
  if (/approaching the maximum storage threshold/i.test(eventMessage) || /storage.*(threshold|full)/i.test(eventMessage)) {
    return getRunbookForMetric('FreeStorageSpace');
  }
  return undefined;
}

/**
 * Classifies an RDS event's free-text message into the AWS-documented event categories this
 * account's `RdsEventSubscription` is actually scoped to (availability/backup/failover/failure/
 * recovery — see AWS docs "Amazon RDS event categories and event messages",
 * USER_Events.Messages.html) purely by matching the EXACT message text AWS emits for each
 * `RDS-EVENT-*` code this project has looked up and confirmed, NOT a broad keyword guess. Returns
 * `undefined` for any message that doesn't match a known, confirmed pattern — the SAME fail-safe
 * "never invent a category from a guess" principle `inferRdsEventRunbook` above already applies,
 * extended to severity/impact instead of just the runbook attachment.
 *
 * WHY THIS MATTERS SEPARATELY FROM THE RUNBOOK LOOKUP: a category tells the reader HOW URGENT
 * this specific event is, even for the ~90% of RDS events with no dedicated runbook entry yet
 * (failover/backup have no CloudWatch-metric-shaped runbook to attach — there is no
 * `RUNBOOK_BY_METRIC['Failover']`). "Backing up DB instance" (RDS-EVENT-0001) is routine and
 * informational; "Multi-AZ instance failover started" (RDS-EVENT-0013) means the database
 * briefly lost its primary and a client-side reconnect/DNS propagation is likely needed —
 * worth a distinct severity even without a full runbook.
 */
function classifyRdsEvent(eventMessage: string): { category: string; severity: 'info' | 'warning' | 'critical'; impact?: string } | undefined {
  // failover (RDS-EVENT-0013/0015/0049/0050/0051): a Multi-AZ failover swaps the standby in as
  // the new primary — the database is briefly unreachable and DNS propagation can take a few
  // minutes, per AWS's own event message text.
  if (/multi-az (instance )?(failover|activation)/i.test(eventMessage)) {
    return {
      category: 'failover',
      severity: 'warning',
      impact: 'The database briefly promoted its standby to primary — connections may have been interrupted, and DNS propagation to the new primary can take a few minutes.',
    };
  }
  // RDS-EVENT-0034: RDS explicitly refused a failover because one just happened — worth
  // escalating (repeated failovers in a short window usually indicate a real underlying
  // instability, not a one-off blip).
  if (/abandoning user requested failover/i.test(eventMessage)) {
    return {
      category: 'failover',
      severity: 'critical',
      impact: 'A failover was requested but REJECTED because one already happened recently — repeated failovers in a short window usually indicate an underlying instability, not a one-off event.',
    };
  }
  // backup (RDS-EVENT-0001/0002): routine, expected, automatic — informational only, never a
  // problem on its own (this project has no confirmed "backup failed"-shaped RDS event message
  // to match against yet; if AWS emits one in this account, add its exact text here rather than
  // guessing at the wording).
  if (/(backing up|finished .*backup)/i.test(eventMessage)) {
    return { category: 'backup', severity: 'info' };
  }
  // recovery (RDS-EVENT-0020/0021/0052/0053/0361/0362): an active recovery in progress — the
  // database is degraded/rebuilding right now.
  if (/recovery (of the db instance|of standby db instance)/i.test(eventMessage) || /multi-az instance recovery/i.test(eventMessage)) {
    return {
      category: 'recovery',
      severity: 'warning',
      impact: 'The database (or its standby) is actively recovering — performance is degraded until this completes.',
    };
  }
  return undefined;
}

/** Color/emoji/SEV-tier keyed by the SAME 3-level severity `classifyRdsEvent` returns — kept as
 * one small lookup rather than inline branching so a 4th severity level (if ever needed) is a
 * 1-line change here, not a scattered set of conditionals through `buildRdsEventEmbed`. An
 * unclassified event (severity `undefined` from `classifyRdsEvent`) defaults to the ORIGINAL
 * behavior (amber/warning) — see the file header on why guessing a color from free text beyond
 * the confirmed patterns above would be a fact dressed as a guess. */
const RDS_EVENT_SEVERITY_META: Record<'info' | 'warning' | 'critical', { emoji: string; color: number; sevTier: string | undefined }> = {
  info: { emoji: '🔵', color: 0x5865f2, sevTier: undefined },
  warning: { emoji: '🟠', color: 0xfaa61a, sevTier: 'SEV-3' },
  critical: { emoji: '🔴', color: 0xed4245, sevTier: 'SEV-1' },
};

function buildRdsEventEmbed(message: RdsEventSnsMessage) {
  const classified = classifyRdsEvent(message['Event Message']);
  const severity = classified?.severity ?? 'warning'; // Unclassified -> same default this file always used (amber).
  const meta = RDS_EVENT_SEVERITY_META[severity];

  const fields: { name: string; value: string; inline?: boolean }[] = [
    { name: 'Database', value: `**${message['Source ID']}**`, inline: true },
    { name: 'Source type', value: `\`${message['Event Source']}\``, inline: true },
    { name: 'What happened', value: message['Event Message'], inline: false },
  ];
  if (classified?.impact) {
    fields.push({ name: '🎯 Impact', value: classified.impact, inline: false });
  }
  const runbook = inferRdsEventRunbook(message['Event Message']);
  if (runbook) fields.push(formatRunbookField(runbook));
  if (message['Event ID']) {
    // The Event ID is a documentation URL such as ...USER_Events.html#RDS-EVENT-0089. The fragment is
    // the part an operator can actually search for, so surface it as well as the link.
    const code = message['Event ID'].split('#').pop();
    fields.push({ name: 'Event', value: `[${code ?? message['Event ID']}](${message['Event ID']})`, inline: true });
  }
  if (message['Identifier Link']) {
    fields.push({ name: 'Console', value: `[Open in RDS](${message['Identifier Link']})`, inline: true });
  }
  const region = process.env.AWS_REGION;
  if (region) {
    fields.push({ name: '🏷️ Metadata', value: `\`\`\`\nRegion:   ${region}\nResource: ${message['Source ID']}\n\`\`\``, inline: false });
  }

  // 'Event Time' is "YYYY-MM-DD HH:MM:SS.mmm" in UTC, which is NOT ISO 8601 and which alert hub rejects
  // outright as a timestamp. Normalise it; if it still will not parse, omit the timestamp rather than
  // sending a payload alert hub will 400 on and losing the notification over a formatting detail.
  const parsed = new Date(message['Event Time'].replace(' ', 'T') + 'Z');
  const timestamp = Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();

  return {
    title: `${meta.emoji}${meta.sevTier ? ` [${meta.sevTier}]` : ''} RDS event · ${message['Source ID']}`,
    color: meta.color,
    fields,
    timestamp,
    footer: { text: 'ops-dashboard · AWS RDS event' },
  };
}

/** alert embed color (decimal, not a hex string — the alert hub API requires an integer) keyed by
 * the alarm's new state — red for ALARM (critical), yellow for INSUFFICIENT_DATA (a
 * missing-data warning — needs configuration attention, NOT benign), green for OK (recovered). */
const COLOR_BY_STATE: Record<CloudWatchAlarmSnsMessage['NewStateValue'], number> = {
  ALARM: 0xed4245, // palette "red"
  INSUFFICIENT_DATA: 0xfaa61a, // palette "orange/yellow"
  OK: 0x57f287, // palette "green"
};

const EMOJI_BY_STATE: Record<CloudWatchAlarmSnsMessage['NewStateValue'], string> = {
  ALARM: '🔴',
  INSUFFICIENT_DATA: '🟠',
  OK: '🟢',
};

const LABEL_BY_STATE: Record<CloudWatchAlarmSnsMessage['NewStateValue'], string> = {
  ALARM: 'ALARM — Needs attention',
  INSUFFICIENT_DATA: 'INSUFFICIENT_DATA — Missing data',
  OK: 'OK — Recovered',
};

/** Extracts the "primary" resource name (the first dimension, usually InstanceId/
 * DBInstanceIdentifier/LoadBalancer/ClusterName+ServiceName) for compact display in an Embed
 * field — no need to show ALL the technical dimensions, just enough for the operator to
 * recognize the resource.
 *
 * Requirement: "should only use instance or resource names, not ids since they're hard to read"
 * — when a name is successfully looked up (`NAME_LOOKUP_BY_DIMENSION`), show ONLY the name, no
 * longer paired with the raw ID. The raw ID is only shown when the name lookup fails (deleted/
 * permission error/no Name tag) — still leaves a clue for manual lookup, instead of losing the
 * information entirely. */
async function formatDimensions(dimensions: CloudWatchAlarmDimension[] | undefined): Promise<string> {
  if (!dimensions || dimensions.length === 0) return '(none)';
  const lines = await Promise.all(
    dimensions.map(async (d) => {
      const lookupName = NAME_LOOKUP_BY_DIMENSION[d.name];
      const name = lookupName ? await lookupName(d.value) : undefined;
      return name ? `**${d.name}**: **${name}**` : `**${d.name}**: \`${d.value}\``;
    }),
  );
  return lines.join('\n');
}

/** SEV tier by alarm state — ALARM WITH a resolvable runbook is SEV-1 (a known, actionable
 * problem type — the reader can act immediately from the Runbook field alone); ALARM with NO
 * runbook entry yet is SEV-2 (still a real breach, but this Lambda cannot state a concrete next
 * step for it); INSUFFICIENT_DATA is SEV-3 (a configuration/data-collection problem, not a metric
 * breach); OK carries no tier (recovered, not an incident) — same "SEV tier depends on whether a
 * concrete impact/next-step is known" principle `opsNotification.ts`'s own SEV-1-vs-SEV-2 rule
 * uses, applied here to "is there a runbook" instead of "is there a stated impact". */
function alarmSevTier(state: CloudWatchAlarmSnsMessage['NewStateValue'], hasRunbook: boolean): string | undefined {
  if (state === 'ALARM') return hasRunbook ? 'SEV-1' : 'SEV-2';
  if (state === 'INSUFFICIENT_DATA') return 'SEV-3';
  return undefined;
}

/** Builds the deep-link to this specific alarm's own CloudWatch console page — the direct,
 * one-click destination `opsNotification.ts`'s own Links convention requires (see that file's
 * header: "only link when it takes the reader directly to the relevant view"), built from the
 * alarm's own ARN rather than a generic "open CloudWatch" link. */
function alarmConsoleLink(alarmArn: string, region: string): string {
  return `https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}#alarmsV2:alarm/${encodeURIComponent(alarmArn.split(':').pop() ?? '')}`;
}

/**
 * CIS BENCHMARK ALARM ENRICHMENT — see the file-header comment on `RUNBOOK_BY_METRIC`'s CIS
 * section in `shared/src/runbookCatalog.ts` for the full "why these alarms are structurally
 * vague" background. Every `CIS-*-Alarm` (namespace `CISBenchmark`) carries `Dimensions: []` —
 * the metric is a raw COUNT of matching CloudTrail log lines, with NO who/what/where. The only
 * way to answer "which account, which principal, which IP, which API call, which resource" is to
 * re-query CloudTrail directly for the specific event name(s) this metric filter matches, scoped
 * to the alarm's own evaluation window (`StateChangeTime` minus the alarm's period).
 *
 * ONE metric filter can match SEVERAL distinct CloudTrail event names (e.g.
 * `SecurityGroupChangesCount` fires on `AuthorizeSecurityGroupIngress` OR
 * `AuthorizeSecurityGroupEgress` OR `RevokeSecurityGroupIngress` OR ... — the CIS Benchmark's own
 * published filter patterns use `||` across multiple eventNames), so this maps to an ARRAY of
 * candidate event names, not one, and looks up each in turn until one actually has a match in the
 * window (the metric CANNOT distinguish which specific event name incremented the count, so
 * showing the first match found is the most useful answer available, not a guess dressed as
 * certainty — this is stated explicitly in the enrichment's own "how this was found" text).
 */
const CIS_METRIC_TO_CLOUDTRAIL_EVENT_NAMES: Record<string, string[]> = {
  CloudTrailConfigChangesCount: ['CreateTrail', 'UpdateTrail', 'DeleteTrail', 'StartLogging', 'StopLogging'],
  ConsoleLoginFailuresCount: ['ConsoleLogin'],
  ConsoleSigninWithoutMFACount: ['ConsoleLogin'],
  IAMPolicyChangesCount: [
    'PutUserPolicy', 'PutGroupPolicy', 'PutRolePolicy', 'CreatePolicy', 'CreatePolicyVersion',
    'AttachUserPolicy', 'AttachRolePolicy', 'AttachGroupPolicy', 'DeleteUserPolicy',
    'DeleteGroupPolicy', 'DeleteRolePolicy', 'DeletePolicy', 'DeletePolicyVersion',
    'DetachUserPolicy', 'DetachRolePolicy', 'DetachGroupPolicy', 'CreateRole',
  ],
  KMSKeyDisableOrDeleteCount: ['DisableKey', 'ScheduleKeyDeletion'],
  NACLChangesCount: [
    'CreateNetworkAcl', 'CreateNetworkAclEntry', 'DeleteNetworkAcl', 'DeleteNetworkAclEntry',
    'ReplaceNetworkAclEntry', 'ReplaceNetworkAclAssociation',
  ],
  RootAccountUsageCount: ['ConsoleLogin'], // Root usage is detected via userIdentity.type === 'Root', not a distinct eventName — see filterCloudTrailEventsForCisMetric.
  RouteTableChangesCount: [
    'CreateRoute', 'CreateRouteTable', 'ReplaceRoute', 'ReplaceRouteTableAssociation',
    'DeleteRouteTable', 'DeleteRoute', 'DisassociateRouteTable',
  ],
  S3BucketPolicyChangesCount: [
    'PutBucketPolicy', 'DeleteBucketPolicy', 'PutBucketAcl', 'PutBucketPublicAccessBlock',
    'DeleteBucketPublicAccessBlock',
  ],
  SecurityGroupChangesCount: [
    'AuthorizeSecurityGroupIngress', 'AuthorizeSecurityGroupEgress', 'RevokeSecurityGroupIngress',
    'RevokeSecurityGroupEgress', 'CreateSecurityGroup', 'DeleteSecurityGroup',
  ],
  UnauthorizedAPICallsCount: [], // No single eventName — matched by errorCode, not eventName; see filterCloudTrailEventsForCisMetric.
  VPCChangesCount: [
    'CreateVpc', 'DeleteVpc', 'CreateVpcPeeringConnection', 'AcceptVpcPeeringConnection',
    'CreateVpnConnection', 'CreateVpnGateway', 'AttachClassicLinkVpc', 'EnableVpcClassicLink',
  ],
};

/** Root-cause detail extracted from a real CloudTrail event for one CIS Benchmark alarm — the
 * exact account/who/what/where a raw metric-filter count can never carry on its own. */
export interface CisEventDetail {
  eventName: string;
  eventTime: Date | undefined;
  principal: string | undefined;
  accountId: string | undefined;
  sourceIpAddress: string | undefined;
  awsRegion: string | undefined;
  resources: string[];
  /** `true` when this event was found by the fallback "any recent CloudTrail management event in
   * the window" scan rather than a targeted eventName lookup (`UnauthorizedAPICallsCount`,
   * matched by errorCode instead — see `filterCloudTrailEventsForCisMetric`) — surfaced so the
   * rendered field can be honest about how much confidence to place in "this is THE event". */
  matchedBy: 'eventName' | 'errorCode';
}

/** Extracts the principal ARN/username CloudTrail recorded for this event — falls back through
 * the same userIdentity shape variations `ai-ops-agent.ts`'s own audit trail already has to
 * handle (an assumed role vs. a direct IAM user vs. the root account each populate different
 * fields), never guessing when none are present. */
function extractPrincipal(userIdentity: Record<string, unknown> | undefined): string | undefined {
  if (!userIdentity) return undefined;
  if (userIdentity.type === 'Root') return 'root';
  const arn = userIdentity.arn;
  if (typeof arn === 'string' && arn.length > 0) return arn;
  const userName = userIdentity.userName;
  if (typeof userName === 'string' && userName.length > 0) return userName;
  return undefined;
}

/** Extracts up to 3 resource identifiers CloudTrail recorded for this event (an event can touch
 * multiple resources — e.g. a security group rule change lists both the rule and the group) —
 * capped to keep the rendered field short, matching `formatDimensions`' own "enough to recognize
 * the resource, not the entire technical record" principle. */
function extractResources(event: CloudTrailEvent): string[] {
  return (event.Resources ?? [])
    .map((r) => r.ResourceName)
    .filter((name): name is string => Boolean(name))
    .slice(0, 3);
}

/**
 * Queries CloudTrail for the specific event(s) that most likely triggered one CIS Benchmark
 * alarm, scoped to a narrow window around the alarm's own `StateChangeTime`. Returns `undefined`
 * (never throws) when CloudTrail has no permission grant, no matching event, or errors — the
 * enrichment is a BEST-EFFORT addition; its absence must never cost the notification itself (same
 * "never let an enrichment failure break delivery" principle already applied to
 * `fetchEc2NameTag`/`fetchNatGatewayNameTag` in this same file).
 *
 * `UnauthorizedAPICallsCount` has no single eventName to filter on (CIS's own published filter
 * pattern matches on `errorCode = "*UnauthorizedOperation" || errorCode = "AccessDenied*"`, not a
 * specific API) — for that one metric, this looks up ALL management events in the window and
 * keeps only the ones whose own CloudTrailEvent JSON shows a matching errorCode, rather than
 * silently returning nothing for the single most security-relevant alarm in the whole set.
 */
async function lookupCisBenchmarkEvent(metricName: string, stateChangeTime: Date, periodSeconds: number): Promise<CisEventDetail | undefined> {
  const eventNames = CIS_METRIC_TO_CLOUDTRAIL_EVENT_NAMES[metricName];
  if (eventNames === undefined) return undefined; // Not a known CIS metric — nothing to look up.

  // A few minutes of slack on both sides: CloudWatch's own evaluation period can lag the actual
  // API call by up to that period, and CloudTrail's own event delivery has a short propagation
  // delay of its own (typically under 5 minutes, per AWS's documented CloudTrail latency).
  const slackMs = Math.max(periodSeconds * 1000, 5 * 60_000);
  const startTime = new Date(stateChangeTime.getTime() - slackMs);
  const endTime = new Date(stateChangeTime.getTime() + slackMs);
  const cloudtrail = getCloudTrailClient();

  try {
    if (metricName === 'UnauthorizedAPICallsCount') {
      const { Events = [] } = await cloudtrail.send(new LookupEventsCommand({ StartTime: startTime, EndTime: endTime, MaxResults: 50 }));
      for (const event of Events) {
        const raw = event.CloudTrailEvent ? (JSON.parse(event.CloudTrailEvent) as Record<string, unknown>) : undefined;
        const errorCode = raw?.errorCode;
        if (typeof errorCode === 'string' && /UnauthorizedOperation|AccessDenied/i.test(errorCode)) {
          return {
            eventName: event.EventName ?? 'UnknownEvent',
            eventTime: event.EventTime,
            principal: extractPrincipal(raw?.userIdentity as Record<string, unknown> | undefined),
            accountId: typeof raw?.recipientAccountId === 'string' ? raw.recipientAccountId : undefined,
            sourceIpAddress: typeof raw?.sourceIPAddress === 'string' ? raw.sourceIPAddress : undefined,
            awsRegion: typeof raw?.awsRegion === 'string' ? raw.awsRegion : undefined,
            resources: extractResources(event),
            matchedBy: 'errorCode',
          };
        }
      }
      return undefined;
    }

    // RootAccountUsageCount also needs a userIdentity.type check on top of the eventName filter
    // (CIS's own filter pattern is `userIdentity.type = "Root"`, not tied to one specific
    // eventName — root can call ANY API, not just ConsoleLogin) — so this queries every
    // management event in the window and filters by userIdentity.type client-side, same
    // client-side-filter approach as the errorCode case above, for the same reason (no
    // eventName-based LookupAttributes filter exists for "any call by root").
    if (metricName === 'RootAccountUsageCount') {
      const { Events = [] } = await cloudtrail.send(new LookupEventsCommand({ StartTime: startTime, EndTime: endTime, MaxResults: 50 }));
      for (const event of Events) {
        const raw = event.CloudTrailEvent ? (JSON.parse(event.CloudTrailEvent) as Record<string, unknown>) : undefined;
        const userIdentity = raw?.userIdentity as Record<string, unknown> | undefined;
        if (userIdentity?.type === 'Root') {
          return {
            eventName: event.EventName ?? 'UnknownEvent',
            eventTime: event.EventTime,
            principal: 'root',
            accountId: typeof raw?.recipientAccountId === 'string' ? raw.recipientAccountId : undefined,
            sourceIpAddress: typeof raw?.sourceIPAddress === 'string' ? raw.sourceIPAddress : undefined,
            awsRegion: typeof raw?.awsRegion === 'string' ? raw.awsRegion : undefined,
            resources: extractResources(event),
            matchedBy: 'eventName',
          };
        }
      }
      return undefined;
    }

    for (const eventName of eventNames) {
      const { Events = [] } = await cloudtrail.send(
        new LookupEventsCommand({
          StartTime: startTime,
          EndTime: endTime,
          LookupAttributes: [{ AttributeKey: 'EventName', AttributeValue: eventName }],
          MaxResults: 5,
        }),
      );
      const event = Events[0];
      if (!event) continue;
      const raw = event.CloudTrailEvent ? (JSON.parse(event.CloudTrailEvent) as Record<string, unknown>) : undefined;
      return {
        eventName,
        eventTime: event.EventTime,
        principal: extractPrincipal(raw?.userIdentity as Record<string, unknown> | undefined),
        accountId: typeof raw?.recipientAccountId === 'string' ? raw.recipientAccountId : undefined,
        sourceIpAddress: typeof raw?.sourceIPAddress === 'string' ? raw.sourceIPAddress : undefined,
        awsRegion: typeof raw?.awsRegion === 'string' ? raw.awsRegion : undefined,
        resources: extractResources(event),
        matchedBy: 'eventName',
      };
    }
    return undefined;
  } catch (err) {
    logger.error(`alarm-notifier: CloudTrail lookup failed for CIS metric ${metricName} (continuing without enrichment)`, err);
    return undefined;
  }
}

/** Renders a `CisEventDetail` as one alert embed field — the account/principal/IP/API-call/
 * resource detail a raw CIS metric count can never carry (see `lookupCisBenchmarkEvent`'s file
 * header). Explicitly states HOW the event was matched when it is a best-effort match rather than
 * an exact one (`errorCode`-matched for UnauthorizedAPICallsCount) — never presents a probable
 * match as a certain one. */
function formatCisEventDetailField(detail: CisEventDetail): { name: string; value: string; inline?: boolean } {
  const lines = [
    `**API call:** \`${detail.eventName}\``,
    detail.principal ? `**Principal:** \`${detail.principal}\`` : undefined,
    detail.sourceIpAddress ? `**Source IP:** \`${detail.sourceIpAddress}\`` : undefined,
    detail.accountId ? `**Account:** \`${detail.accountId}\`` : undefined,
    detail.resources.length > 0 ? `**Resource(s):** ${detail.resources.map((r) => `\`${r}\``).join(', ')}` : undefined,
    detail.matchedBy === 'errorCode'
      ? '_Matched by error code (this metric has no single API call name — showing the closest denied call found in the window)._'
      : undefined,
  ].filter((l): l is string => Boolean(l));
  return { name: '🔎 CloudTrail event found', value: lines.join('\n'), inline: false };
}

/** Builds a full, "enterprise-grade" alert embed object — with title/color/fields/timestamp/
 * footer. `alertHook.ts` flattens it into the hub payload {severity, title, text, tenant}. */
async function buildAlarmEmbed(message: CloudWatchAlarmSnsMessage) {
  const state = message.NewStateValue;
  const trigger = message.Trigger;

  const fields: { name: string; value: string; inline?: boolean }[] = [
    { name: 'Status', value: `${EMOJI_BY_STATE[state]} ${LABEL_BY_STATE[state]}`, inline: true },
    { name: 'Region', value: message.Region, inline: true },
  ];

  if (trigger?.Namespace && trigger.MetricName) {
    fields.push({ name: 'Metric', value: `\`${trigger.Namespace} / ${trigger.MetricName}\``, inline: true });
  }
  if (trigger?.Threshold !== undefined && trigger.ComparisonOperator) {
    fields.push({
      name: 'Configured threshold',
      value: `\`${trigger.ComparisonOperator} ${trigger.Threshold}\``,
      inline: true,
    });
  }
  fields.push({ name: 'Related resource', value: await formatDimensions(trigger?.Dimensions), inline: false });
  fields.push({ name: 'Evaluation details', value: message.NewStateReason || '(none)', inline: false });

  // Only attach a runbook on a genuine problem state — an OK (recovered) notification doesn't
  // need "what to do about it" guidance, and INSUFFICIENT_DATA's own guidance (missing agent/
  // permission) is different enough from a metric threshold breach that reusing the same
  // metric-keyed runbook here would be misleading.
  const runbook = state === 'ALARM' && trigger?.MetricName ? getRunbookForMetric(trigger.MetricName) : undefined;

  // Impact is only stated for an active ALARM — recovered (OK) has no ongoing consequence, and
  // INSUFFICIENT_DATA's problem is missing data itself (already stated by its own Status label),
  // not a metric-threshold consequence to restate here.
  if (state === 'ALARM') {
    fields.push({
      name: '🎯 Impact',
      value: runbook
        ? `${runbook.symptom} See the Runbook field below for how to confirm and remediate.`
        : 'This metric has breached its configured threshold — no dedicated runbook exists yet for this specific metric, check the Evaluation details above and the linked CloudWatch alarm for context.',
      inline: false,
    });
  }

  // CIS Benchmark alarm enrichment (see `lookupCisBenchmarkEvent`'s file header): only attempted
  // for an active ALARM on a `CISBenchmark`-namespace metric — this is exactly the case where the
  // raw metric count alone carries no who/what/where, and the ONLY case worth the extra
  // CloudTrail API call for.
  if (state === 'ALARM' && trigger?.Namespace === 'CISBenchmark' && trigger.MetricName) {
    const stateChangeTime = new Date(message.StateChangeTime);
    if (!Number.isNaN(stateChangeTime.getTime())) {
      const cisDetail = await lookupCisBenchmarkEvent(trigger.MetricName, stateChangeTime, trigger.Period ?? 300);
      if (cisDetail) fields.push(formatCisEventDetailField(cisDetail));
    }
  }

  if (runbook) fields.push(formatRunbookField(runbook));

  // `message.Region` is a HUMAN-READABLE display name ("Asia Pacific (Singapore)"), NOT a region
  // code — CloudWatch puts the friendly name there, not "ap-southeast-1". A console deep link
  // needs the actual region code, which is only reliably available from this Lambda's own
  // runtime environment (`process.env.AWS_REGION`, set automatically by Lambda) — same source
  // every other embed builder in this file already uses for its own links/metadata.
  const regionCode = process.env.AWS_REGION;
  if (regionCode) {
    const links = [{ label: 'Open in CloudWatch', url: alarmConsoleLink(message.AlarmArn, regionCode) }];
    fields.push({ name: '🔗 Links', value: links.map((l) => `[${l.label}](${l.url})`).join('\n'), inline: false });
  }
  fields.push({ name: '🏷️ Metadata', value: `\`\`\`\nRegion:   ${message.Region}\nResource: ${message.AlarmArn}\n\`\`\``, inline: false });

  const sevTier = alarmSevTier(state, Boolean(runbook));
  return {
    title: `${EMOJI_BY_STATE[state]}${sevTier ? ` [${sevTier}]` : ''} ${message.AlarmName}`,
    description: message.AlarmDescription ?? undefined,
    color: COLOR_BY_STATE[state],
    fields,
    timestamp: message.StateChangeTime,
    footer: { text: 'ops-dashboard · AWS CloudWatch Alarm' },
  };
}

/**
 * The main handler — every `SNSEvent` can contain multiple `Records` (SNS batches several
 * messages into one invoke) — processes EACH record independently, so one failing record
 * (broken JSON.parse, or a payload that isn't a standard CloudWatch Alarm — e.g. a manually sent
 * SNS message with the wrong shape) must NOT break the other records in the same batch.
 */
export async function handler(event: SNSEvent): Promise<void> {
  for (const record of event.Records) {
    try {
      const parsed: unknown = JSON.parse(record.Sns.Message);

      // RDS events and GuardDuty findings are both checked FIRST because they are narrower shapes:
      // neither carries an AlarmName, so there is no ambiguity, and checking them first keeps the
      // alarm path below untouched.
      if (isRdsEventMessage(parsed)) {
        await postAlertEmbeds([buildRdsEventEmbed(parsed)]);
        continue;
      }
      if (isGuardDutyFindingMessage(parsed)) {
        await postAlertEmbeds([buildGuardDutyFindingEmbed(parsed)]);
        continue;
      }

      const message = parsed as CloudWatchAlarmSnsMessage;
      if (!message.AlarmName || !message.NewStateValue) {
        logger.error('alarm-notifier: SNS message matches neither the CloudWatch Alarm, RDS event, nor GuardDuty finding shape (ignoring)', record.Sns.MessageId);
        continue;
      }
      // INSUFFICIENT_DATA -> OK is an INITIALIZATION transition (the alarm was just recreated by
      // PutMetricAlarm after the instance's scheduled restart — see alarm-baseline-manager.ts),
      // not an actual "issue resolved". There's no InsufficientDataActions, so this message can
      // only arise from the alarm getting enough data for the first time, not from a prior ALARM
      // -> skip it to avoid a fake "resolved" notification masking a real ALARM notification.
      if (message.NewStateValue === 'OK' && message.OldStateValue === 'INSUFFICIENT_DATA') {
        logger.info('alarm-notifier: skipping INSUFFICIENT_DATA -> OK transition (alarm just initialized, not actually resolved)', message.AlarmName);
        continue;
      }
      await postAlertEmbeds([await buildAlarmEmbed(message)]);
    } catch (err) {
      // Do NOT throw — one failing message shouldn't cause SNS to retry the whole batch (a
      // failing Lambda subscriber makes SNS retry per its own policy, which could send
      // duplicate notifications multiple times).
      logger.error('alarm-notifier: failed to send alert for one message (ignoring, not throwing)', { messageId: record.Sns.MessageId, err });
    }
  }
}
