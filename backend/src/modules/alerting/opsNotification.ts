import type { AlertEmbed, AlertEmbedField } from './alertHook.js';

/**
 * `opsNotification.ts` — a SHARED, incident-report-grade template for every operational alert hub
 * notification in this project (both automated Lambda alerts and ad-hoc manual ops actions
 * performed via CLI/chat).
 *
 * WHY THIS SHAPE (not a free-form description, not the original bare 5W1H)
 *
 * The original version of this file used a plain 5W1H template (What/Why/Where/Who/When/How).
 * That was a real improvement over free-form prose, but user feedback after living with it in
 * production was specific: too many notifications arrived without enough to independently
 * understand THE PROBLEM, THE REASON, and THE FIX in one read — a reader still had to open
 * CloudWatch Logs or the AWS Console to answer "does this matter, and what do I do". This version
 * keeps every 5W1H concept (nothing is removed, see the mapping table below) but organizes it
 * around the shape a real incident-management notification uses (PagerDuty/Opsgenie-style):
 * severity tier first, then impact, then likely cause, then the concrete next step, then a direct
 * link to go investigate, then the resource metadata needed to act safely.
 *
 * SEVERITY TIER (SEV-1..4) — NOT a replacement for `OpsNotificationSeverity`
 *
 * `OpsNotificationSeverity` (critical/warning/success/info) still drives the emoji/color exactly
 * as before — that mapping is unchanged and every existing caller keeps working. The SEV tier is
 * a SECOND, more granular signal shown ONLY for critical/warning (a success/info notification is
 * by definition not an incident, so no SEV label is shown — matching this project's own "omission
 * rule": don't show a slot that doesn't carry a real decision). Within `critical`, SEV-1 vs SEV-2
 * is decided by whether the caller supplied `impact` (a concrete, stated consequence) — a critical
 * failure with a KNOWN, STATED business/service impact is the highest urgency (SEV-1); a critical
 * failure whose impact hasn't been characterized yet is SEV-2 (still urgent, but "we know
 * something broke" is not the same as "we know it's costing money/availability right now",
 * per the same principle this project already applies to `ai-ops-agent.ts`'s "state what you
 * verified, not what you assume"). `warning` is always SEV-3. This is a DERIVED signal (never a
 * caller-supplied field) — a caller cannot accidentally miscalibrate it by passing the wrong
 * number, it can only follow from severity + whether impact was actually characterized.
 *
 * FIELD MAPPING (5W1H concept -> new slot, and why each moved)
 *
 *   WHAT         -> embed `title`, prefixed with severity emoji AND the SEV tier badge (SEV-1/
 *                   SEV-2/SEV-3 in brackets) when applicable — the two facts a reader must not
 *                   miss even in a truncated notification-list preview: what happened, how urgent.
 *   WHY          -> embed `description` — unchanged from the original (still the best fit for a
 *                   free-flowing paragraph, see the original reasoning below).
 *   IMPACT (new) -> a full-width field, placed FIRST among fields (immediately after the
 *                   description) — the concrete consequence ("what breaks/who is affected/what it
 *                   costs"), which is exactly the fact "why" alone often couldn't express on its
 *                   own (why != impact: "why" is the trigger/root cause, "impact" is the
 *                   consequence — the payment-gateway example that prompted this redesign needed
 *                   BOTH: "5xx rate is 8.5%" (why) AND "customers cannot complete payment,
 *                   estimated 30% order drop" (impact) as two distinct facts).
 *   LIKELY CAUSES (new) -> a full-width field listing 1+ candidate causes, ONLY when the caller
 *                   has more than one plausible explanation to offer (a single, confirmed root
 *                   cause still belongs in `why`, not here — this field exists specifically for
 *                   "here's what it's probably NOT confirmed to be yet", the same "candidate list,
 *                   not a fact" the original payment-gateway example showed with its own 3-item
 *                   list). Rendered as a markdown bullet list.
 *   NEXT STEPS   -> the renamed, expanded `how` — same input field name (`how`) for backward
 *                   compatibility with every existing caller, but now supports either a single
 *                   string (rendered as before) or a string array (rendered as a numbered list —
 *                   "Immediate Actions" in the reference template are inherently a sequence, and a
 *                   numbered list reads as an ordered checklist, a plain paragraph does not).
 *   RUNBOOK      -> unchanged, still composed via `formatRunbookField` by the caller and passed
 *                   through `extra` — this file does not know about the runbook catalog itself.
 *   LINKS (new)  -> a full-width field of markdown links (label -> URL) — the reference template's
 *                   own "Quick Links" section (Dashboard/Logs/Console) generalized into one
 *                   reusable field instead of every caller inventing its own link formatting.
 *   METADATA (new) -> a single, full-width, code-block-formatted field: Account · Region ·
 *                   Resource ARN · Owner — deliberately ONE field, not 4 separate ones, because
 *                   alert hub's embed field grid only fits 3 inline fields per row and metadata is
 *                   read together as a unit ("which account/region/resource is this"), never one
 *                   piece without the others.
 *   WHERE / WHO  -> UNCHANGED, still two inline fields exactly as before (kept for backward
 *                   compatibility and because they remain the fastest way to show "which
 *                   resource, whose action" side by side).
 *   WHEN         -> UNCHANGED, still the embed's native `timestamp` plus the optional override
 *                   field for a past/windowed event, exactly as before.
 *
 * OMISSION RULE (UNCHANGED from the original, still the core design principle): every field
 * beyond `what` and `severity` is optional and DROPPED entirely when absent — never an empty
 * field, a "N/A", or a placeholder dash. Every new field above follows this same rule: `impact`/
 * `likelyCauses`/`links`/`account`/`region`/`resourceArn`/`owner` are all optional, and a caller
 * that has none of them produces the exact same output as before this redesign (verified by
 * `opsNotification.test.ts`'s "nothing else supplied" case). This is a strict superset of the
 * original template, not a replacement — no existing caller was required to change to keep
 * working, though most were then updated separately to actually populate the new slots where
 * they have the data (see the individual Lambda files).
 */

export type OpsNotificationSeverity = 'success' | 'info' | 'warning' | 'critical';

/** The AWS Console link builders below all assume this partition's console domain — correct for
 * every region this project deploys to today (ap-southeast-1, us-east-1 for Cost Explorer) and
 * for any other standard (non-China, non-GovCloud) AWS partition; this project has never deployed
 * to either of those, so no partition parameter is threaded through for a case that cannot occur. */
export interface OpsNotificationLink {
  /** Short label shown as the link text, e.g. "CloudWatch Dashboard", "View Error Logs". */
  label: string;
  url: string;
}

const SEVERITY_META: Record<OpsNotificationSeverity, { emoji: string; color: number; label: string }> = {
  // Colors match the palette already used across alarm-notifier.ts/health-report.ts/
  // cost-collector.ts, so a manual notification and an automated one are visually consistent in
  // the same channel.
  critical: { emoji: '🔴', color: 0xed4245, label: 'CRITICAL' },
  warning: { emoji: '🟠', color: 0xfaa61a, label: 'WARNING' },
  success: { emoji: '🟢', color: 0x57f287, label: 'SUCCESS' },
  info: { emoji: '🔵', color: 0x5865f2, label: 'INFO' },
};

/**
 * Derives the SEV tier badge shown in the title — `undefined` for success/info (see the file
 * header: a non-incident notification carries no SEV label). Pure function of severity + whether
 * `impact` was supplied, so it can never drift out of sync with the fields actually rendered.
 */
function sevTierFor(severity: OpsNotificationSeverity, hasImpact: boolean): string | undefined {
  if (severity === 'critical') return hasImpact ? 'SEV-1' : 'SEV-2';
  if (severity === 'warning') return 'SEV-3';
  return undefined;
}

export interface OpsNotificationInput {
  /** WHAT happened — a single, specific sentence (not a category label). Becomes the embed
   * title, prefixed with the severity emoji (and the SEV tier badge, when applicable). This is
   * the only truly required field: a notification that cannot state what happened in one line
   * isn't ready to send. */
  what: string;
  severity: OpsNotificationSeverity;
  /** WHY it happened, or why it matters — the triggering condition or root cause (NOT the
   * consequence — see `impact` for that). Rendered as the embed description. */
  why?: string;
  /** THE CONCRETE CONSEQUENCE — what breaks, who/what is affected, what it costs. Distinct from
   * `why` (the trigger) — e.g. why: "5xx error rate is 8.5%", impact: "Customers cannot complete
   * checkout; estimated 30% order drop while this persists." Presence of this field is also what
   * upgrades a `critical` notification's SEV tier from SEV-2 to SEV-1 (see the file header) — only
   * set this when there is a REAL, known consequence to state, never a guessed number to force a
   * higher tier. */
  impact?: string;
  /** ONE OR MORE plausible (not yet confirmed) explanations — use this instead of `why` when there
   * are multiple real candidates and the notification is sent before root-causing is complete
   * (the whole point of paging someone IS often before the cause is nailed down). If there is
   * exactly one CONFIRMED cause, state it in `why` instead — this field is specifically for an
   * honest "here's what it's probably one of these" list. */
  likelyCauses?: string[];
  /** WHERE it happened — resource id/name, environment, region, e.g.
   * "abc-stg-rds-postgres (Staging, ap-southeast-1)". Kept as ONE string rather than separate
   * resource/environment/region fields — most callers only know some of those, and a single
   * free-text field lets them include exactly what they have without empty sub-fields. For
   * structured account/region/resource-arn/owner metadata shown as its own field, see `account`/
   * `region`/`resourceArn`/`owner` below instead — the two are complementary, not duplicates:
   * `where` is a short, human-scannable label, `metadata` is the precise identifiers needed to
   * actually act (e.g. paste into the AWS CLI) without re-deriving them from the label text. */
  where?: string;
  /** WHO is responsible for or triggered this — a Lambda/system name ("system:alarm-baseline-
   * manager") or a human operator, matching the `executedBy` convention already used in
   * `ActionAuditRecord`. */
  who?: string;
  /** WHEN it happened, ONLY when the default (the notification's own send time, shown via the
   * embed's native timestamp) is not accurate enough — e.g. a time window or a past event being
   * reported late. Rendered as a normal field, since the embed timestamp slot can only hold one
   * instant, not a range. */
  when?: string;
  /** THE NEXT STEP(S) — the action already taken, or what the reader should do. A single string
   * renders as a plain sentence (unchanged from the original `how`); an array renders as a
   * numbered checklist — use an array specifically when there is a real SEQUENCE of immediate
   * actions (check X, then rollback Y, then notify Z), matching the reference incident-report
   * template's own "Immediate Actions" list shape. */
  how?: string | string[];
  /** Direct links to go investigate/act — a CloudWatch dashboard, a Logs Insights query, an AWS
   * Console deep link, a runbook wiki page, etc. Rendered as one markdown-linked line per entry,
   * in the given order. Omit entirely rather than link to a generic, non-specific console page —
   * a link is only worth including when it takes the reader directly to the relevant view. */
  links?: OpsNotificationLink[];
  /** The AWS Account ID this notification concerns — shown in the Metadata field. Only set this
   * from a real, already-known value (e.g. `process.env.AWS_ACCOUNT_ID`) — never hardcode or
   * guess an account id. */
  account?: string;
  /** The AWS region this notification concerns — shown in the Metadata field. Every Lambda in
   * this project already reads `process.env.AWS_REGION` for its own AWS SDK client construction
   * (see `core/aws-clients.ts`), so this is normally free to supply. */
  region?: string;
  /** The specific resource ARN/identifier this notification concerns, when more precise than
   * `where`'s human-readable label — shown in the Metadata field, formatted as inline code so it
   * can be copy-pasted directly into the AWS CLI/Console search box. */
  resourceArn?: string;
  /** The team/person who owns this resource, when known (e.g. read from a `SecurityExceptionOwner`
   * or similar ownership tag already on the resource) — shown in the Metadata field. Never
   * fabricate an owner from a guess; omit when genuinely unknown. */
  owner?: string;
  /** Extra structured facts that don't fit any of the named slots above (counts, durations, ids)
   * — appended after every named field, in the given order. Each caller decides `inline` for its
   * own fields, same as any other AlertEmbedField. */
  extra?: AlertEmbedField[];
  /** Overrides the default footer text ("ops-dashboard · Ops Notification"). */
  footer?: string;
  /** ISO-8601 timestamp overriding "now" for the embed's native timestamp slot — use when the
   * notification is generated well after the event it describes (e.g. a batch summary). */
  timestampOverride?: string;
}

/** Renders `how` as either a plain sentence (string input, unchanged from the original template)
 * or a numbered checklist (array input) — see `OpsNotificationInput.how`'s own doc comment for
 * when to use which. */
function formatNextSteps(how: string | string[]): string {
  if (typeof how === 'string') return how;
  return how.map((step, i) => `${i + 1}. ${step}`).join('\n');
}

/** Renders `likelyCauses` as a markdown bullet list — always plural-shaped even for a single
 * entry, since "likely causes" (vs. a single confirmed `why`) is inherently framed as "one of
 * these", not a flat statement. */
function formatLikelyCauses(causes: string[]): string {
  return causes.map((c) => `• ${c}`).join('\n');
}

/** Renders `links` as one markdown link per line. */
function formatLinks(links: OpsNotificationLink[]): string {
  return links.map((l) => `[${l.label}](${l.url})`).join('\n');
}

/** Renders account/region/resourceArn/owner as a single code-block field — omits any individual
 * line whose value wasn't supplied (same omission rule as every other optional slot), and returns
 * `undefined` (render nothing) when NONE of the four were supplied, rather than an empty field. */
function formatMetadata(params: { account?: string; region?: string; resourceArn?: string; owner?: string }): string | undefined {
  const lines: string[] = [];
  if (params.account) lines.push(`Account:  ${params.account}`);
  if (params.region) lines.push(`Region:   ${params.region}`);
  if (params.resourceArn) lines.push(`Resource: ${params.resourceArn}`);
  if (params.owner) lines.push(`Owner:    ${params.owner}`);
  if (lines.length === 0) return undefined;
  return `\`\`\`\n${lines.join('\n')}\n\`\`\``;
}

/**
 * Builds one enterprise-grade alert embed from an incident-report-shaped input, dropping every
 * field that wasn't supplied. Pure function — no network/AWS calls — so both `postAlertEmbeds`
 * (production Lambdas) and any ad-hoc/manual notifier can call it identically and get the exact
 * same layout.
 */
export function buildOpsNotificationEmbed(input: OpsNotificationInput): AlertEmbed {
  const meta = SEVERITY_META[input.severity];
  const sevTier = sevTierFor(input.severity, Boolean(input.impact));
  const fields: AlertEmbedField[] = [];

  if (input.impact) fields.push({ name: '🎯 Impact', value: input.impact, inline: false });
  if (input.likelyCauses && input.likelyCauses.length > 0) {
    fields.push({ name: '🔍 Likely causes', value: formatLikelyCauses(input.likelyCauses), inline: false });
  }
  if (input.where) fields.push({ name: 'Where', value: input.where, inline: true });
  if (input.who) fields.push({ name: 'Who', value: input.who, inline: true });
  if (input.when) fields.push({ name: 'When', value: input.when, inline: true });
  if (input.how) fields.push({ name: '🛠️ Next steps', value: formatNextSteps(input.how), inline: false });
  if (input.extra) fields.push(...input.extra);
  if (input.links && input.links.length > 0) fields.push({ name: '🔗 Links', value: formatLinks(input.links), inline: false });
  const metadata = formatMetadata(input);
  if (metadata) fields.push({ name: '🏷️ Metadata', value: metadata, inline: false });

  return {
    title: `${meta.emoji}${sevTier ? ` [${sevTier}]` : ''} ${input.what}`,
    description: input.why,
    color: meta.color,
    fields,
    timestamp: input.timestampOverride ?? new Date().toISOString(),
    footer: { text: input.footer ?? 'ops-dashboard · Ops Notification' },
  };
}
