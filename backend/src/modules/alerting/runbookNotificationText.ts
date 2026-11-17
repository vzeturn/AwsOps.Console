import type { RunbookEntry } from '@ops-dashboard/shared';
import type { DiscordEmbedField } from './discordWebhook.js';

/**
 * `runbookNotificationText.ts` — renders a `RunbookEntry` (the shared symptom/diagnosis/
 * remediation/rollback/escalation catalog in `shared/src/runbookCatalog.ts`) as ONE compact
 * Discord embed field, so every notification composer in this project can answer "which
 * runbook/playbook applies here, and what's the very next step" the same way, instead of each
 * Lambda inventing its own ad-hoc phrasing.
 *
 * WHY A DEDICATED FORMATTER, NOT "just dump the whole RunbookEntry"
 *
 * `RunbookEntry` is written for the runbook DRAWER on the dashboard (multi-section, meant to be
 * read end-to-end when someone is actively working the problem). A Discord notification is read
 * on a phone in a few seconds — showing every diagnosis/remediation/escalation step there would
 * bury the one fact that matters ("what is this, what do I do first") under text nobody will read
 * in that context. So this shows only: the runbook title (what this IS, in the same words the
 * dashboard uses — so the two never disagree), the FIRST remediation step (the very next action),
 * and the FIRST escalateWhen condition (the most important "stop and get help" trigger) — with a
 * pointer to open the full runbook on the dashboard for the rest.
 *
 * Every remediation/escalation array in the catalog is written with its most important entry
 * FIRST (see `runbookCatalog.ts`'s own field ordering/comments), so taking `[0]` is a deliberate
 * choice, not an arbitrary truncation.
 */

/** Discord embed fields are capped at 1024 characters (Discord API limit, same constraint already
 * documented in `health-report.ts`'s `MAX_LISTED_ALARMS`) — truncate defensively rather than
 * risking Discord rejecting the whole payload over one long field. */
const DISCORD_FIELD_VALUE_MAX_CHARS = 1024;

function truncate(value: string): string {
  if (value.length <= DISCORD_FIELD_VALUE_MAX_CHARS) return value;
  return `${value.slice(0, DISCORD_FIELD_VALUE_MAX_CHARS - 1)}…`;
}

/**
 * Builds the "Runbook" field for a notification embed. `inline` defaults to `false` (a runbook
 * excerpt is usually a full sentence or two — see the same reasoning already applied to `how` in
 * `opsNotification.ts`, deliberately not inlined so it's never visually squeezed).
 */
export function formatRunbookField(entry: RunbookEntry, options: { inline?: boolean } = {}): DiscordEmbedField {
  const firstRemediation = entry.remediation[0];
  const firstEscalation = entry.escalateWhen[0];
  const lines = [
    `**${entry.title}**`,
    `Next step: ${firstRemediation}`,
    `Escalate if: ${firstEscalation}`,
  ];
  return { name: 'Runbook', value: truncate(lines.join('\n')), inline: options.inline ?? false };
}
