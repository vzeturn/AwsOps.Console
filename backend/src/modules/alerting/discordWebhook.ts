import { GetParameterCommand } from '@aws-sdk/client-ssm';
import { getSsmClient } from '../../core/aws-clients.js';
import { logger } from '../../shared-kernel/logger.js';

/**
 * `discordWebhook.ts` — a POST-Discord-Embed helper SHARED by every Lambda that needs to proactively
 * send notifications to Discord (extracted from logic that used to live in `discord-alarm-notifier.ts`,
 * which only served 1 fixed SNS CloudWatch Alarm flow). `cost-collector.ts` (anomalous-cost alerts)
 * and `infra-review-collector.ts` (new/high-priority cost-optimization finding alerts) both need to
 * POST a Discord Embed using the SAME auth + error-handling approach — avoiding duplicating the
 * SSM Parameter read/cache logic + `fetch` calls in 3 different places.
 *
 * Reads the parameter name from the `DISCORD_WEBHOOK_URL_PARAM_NAME` environment variable — the
 * SAME env var name already used in `discord-alarm-notifier.ts` (the same SSM Parameter;
 * `infra/ops-dashboard.yaml` grants `ssm:GetParameter` permission separately to each Lambda that
 * needs it — not an unintentionally shared secret).
 */
const DISCORD_WEBHOOK_URL_PARAM_NAME = process.env.DISCORD_WEBHOOK_URL_PARAM_NAME;

/** Cached at module scope (cold start) — reads SSM only once per execution environment, following
 * the same pattern as `fetchCachedToken`/`fetchCachedWebhookUrl` in `ec2-state-manager-client.ts`/
 * `discord-alarm-notifier.ts`. Errors are NOT cached — the next call within the same execution
 * environment is retried. */
let cachedWebhookUrlPromise: Promise<string> | undefined;

function fetchCachedWebhookUrl(): Promise<string> {
  if (!cachedWebhookUrlPromise) {
    if (!DISCORD_WEBHOOK_URL_PARAM_NAME) {
      cachedWebhookUrlPromise = Promise.reject(new Error('Missing required environment variable: DISCORD_WEBHOOK_URL_PARAM_NAME'));
    } else {
      cachedWebhookUrlPromise = getSsmClient()
        .send(new GetParameterCommand({ Name: DISCORD_WEBHOOK_URL_PARAM_NAME, WithDecryption: true }))
        .then((result) => {
          const value = result.Parameter?.Value;
          if (!value) throw new Error(`SSM Parameter '${DISCORD_WEBHOOK_URL_PARAM_NAME}' has no value`);
          return value;
        });
    }
    cachedWebhookUrlPromise = cachedWebhookUrlPromise.catch((err) => {
      cachedWebhookUrlPromise = undefined;
      throw err;
    });
  }
  return cachedWebhookUrlPromise;
}

export interface DiscordEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface DiscordEmbed {
  title: string;
  description?: string;
  color: number;
  fields: DiscordEmbedField[];
  timestamp?: string;
  footer?: { text: string };
}

/** The exact 4 colors `opsNotification.ts`'s `SEVERITY_META` and `discord-alarm-notifier.ts`'s
 * own state/tier color tables use — reversed here so this single logging point can recover an
 * approximate severity label from any embed's `color`, regardless of which of the ~16 call sites
 * built it. Deliberately NOT importing `OpsNotificationSeverity` (that would create a dependency
 * from this generic, shared POST helper back onto one specific caller's vocabulary) — color is
 * already the one piece of information every embed in this codebase carries, by construction. */
const SEVERITY_LABEL_BY_COLOR: Record<number, string> = {
  0xed4245: 'critical',
  0xfaa61a: 'warning',
  0x57f287: 'success',
  0x5865f2: 'info',
};

function severityLabelForColor(color: number): string {
  return SEVERITY_LABEL_BY_COLOR[color] ?? `unknown(${color})`;
}

/**
 * Logs a structured, single-line JSON record of every embed this function is about to attempt to
 * send — the durable record this project's own Discord channel does not provide on its own
 * (Discord has no query/analytics API for a channel's own message history, and messages scroll
 * out of a human's attention within minutes). Written to CloudWatch Logs (via the shared
 * `logger.ts`, the cheapest storage this project already pays for and already queries via Log
 * Insights, e.g. `discord-alarm-notifier.ts`'s own error logs) rather than a new S3/DynamoDB
 * store, specifically to avoid standing up new infrastructure for a feature whose entire purpose
 * is retrospective analysis, not a live read path.
 *
 * Logged UNCONDITIONALLY, before the POST is attempted (not after a success/failure branch) —
 * this record's purpose is "what did the system DECIDE to alert about", which is true and worth
 * keeping regardless of whether the Discord webhook itself happened to be reachable at that
 * moment. A later Log Insights query filtering on `"discord-notification-sent"` can therefore
 * answer "how many CRITICAL alerts fired this week, from which Lambda, about what" without
 * depending on Discord's own message history at all.
 */
function logNotificationSent(embed: DiscordEmbed): void {
  logger.info('discord-notification-sent', {
    title: embed.title,
    severity: severityLabelForColor(embed.color),
    footer: embed.footer?.text,
    fieldNames: embed.fields.map((f) => f.name),
    timestamp: embed.timestamp,
  });
}

/**
 * POST 1 or more Embeds to a Discord Incoming Webhook. Does NOT throw to the caller — every error
 * (missing env, SSM read failure, network failure, Discord returning non-2xx) is caught and
 * logged, so a failed notification NEVER breaks the main job (writing the cost/report cache) that
 * calls this function — the same "auxiliary features must not block the main flow" principle
 * already applied to `threshold-history-service.ts`/`recordThresholdHistorySafely`.
 */
export async function postDiscordEmbeds(embeds: DiscordEmbed[]): Promise<void> {
  for (const embed of embeds) logNotificationSent(embed);
  try {
    const webhookUrl = await fetchCachedWebhookUrl();
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ embeds }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '(could not read response body)');
      throw new Error(`Discord webhook returned an error ${res.status}: ${body}`);
    }
  } catch (err) {
    logger.error('discordWebhook: failed to send Discord notification (ignored, does not break the main job)', err);
  }
}
