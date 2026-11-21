import { GetParameterCommand } from '@aws-sdk/client-ssm';
import { getSsmClient } from '../../core/aws-clients.js';
import { logger } from '../../shared-kernel/logger.js';

/**
 * `alertHook.ts` — the ONE outbound path for every operational alert this project raises (CloudWatch
 * alarms, RDS events, GuardDuty findings, cost anomalies, governance/security Lambdas, the AI ops
 * agent, the health report).
 *
 * WHERE ALERTS GO. Alerts are posted to the alert hook of the owner's Request Tracking hub (issued
 * with the hub's `set_alert_hook` for project `ops-dashboard`). The hub opens one incident request
 * per warning/critical alert and settles it there, so problems are tracked to closure instead of
 * scrolling out of a chat channel (Request Tracking ADR 0070 / RT-0484; moved here in RT-0490).
 *
 * WHAT IS SENT. Callers keep building the same structured embed (`AlertEmbed`: title, description,
 * fields, color) via `opsNotification.ts` or their own builders. This file flattens it into the hub
 * contract `{ severity, title, text, tenant }`:
 *   - severity comes from the embed color (the 4-color palette every builder in this codebase uses);
 *   - ONLY `critical` and `warning` are posted. `success`/`info` (and an unrecognized color) are
 *     logged only: they are not incidents, and opening a hub request for "resolved"/"daily summary"
 *     messages would bury the real ones.
 *
 * SECRET HANDLING. The hook URL carries its own credential, so it lives in an SSM SecureString whose
 * NAME (not value) is passed in `ALERT_HOOK_URL_PARAM_NAME`, read with `WithDecryption: true` and
 * cached per execution environment (errors are not cached, the next call retries).
 */
const ALERT_HOOK_URL_PARAM_NAME = process.env.ALERT_HOOK_URL_PARAM_NAME;

/** Optional tenant label sent with each alert; this product serves one AWS account, so it is
 * normally empty. */
const ALERT_TENANT = process.env.ALERT_TENANT ?? '';

let cachedHookUrlPromise: Promise<string> | undefined;

function fetchCachedHookUrl(): Promise<string> {
  if (!cachedHookUrlPromise) {
    if (!ALERT_HOOK_URL_PARAM_NAME) {
      cachedHookUrlPromise = Promise.reject(new Error('Missing required environment variable: ALERT_HOOK_URL_PARAM_NAME'));
    } else {
      cachedHookUrlPromise = getSsmClient()
        .send(new GetParameterCommand({ Name: ALERT_HOOK_URL_PARAM_NAME, WithDecryption: true }))
        .then((result) => {
          const value = result.Parameter?.Value;
          if (!value) throw new Error(`SSM Parameter '${ALERT_HOOK_URL_PARAM_NAME}' has no value`);
          return value;
        });
    }
    cachedHookUrlPromise = cachedHookUrlPromise.catch((err) => {
      cachedHookUrlPromise = undefined;
      throw err;
    });
  }
  return cachedHookUrlPromise;
}

export interface AlertEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface AlertEmbed {
  title: string;
  description?: string;
  color: number;
  fields: AlertEmbedField[];
  timestamp?: string;
  footer?: { text: string };
}

export type AlertSeverity = 'critical' | 'warning' | 'success' | 'info';

/** The 4 colors `opsNotification.ts`'s `SEVERITY_META` and the alarm notifier's own state/tier
 * tables use. Color is the one piece of severity information every embed carries by construction. */
const SEVERITY_BY_COLOR: Record<number, AlertSeverity> = {
  0xed4245: 'critical',
  0xfaa61a: 'warning',
  0x57f287: 'success',
  0x5865f2: 'info',
};

export function severityForColor(color: number): AlertSeverity | undefined {
  return SEVERITY_BY_COLOR[color];
}

/** Hub payload. `text` is plain markdown-ish text: description first, then one block per field. */
export interface AlertHookPayload {
  severity: 'critical' | 'warning';
  title: string;
  text: string;
  tenant: string;
}

export function toAlertHookPayload(embed: AlertEmbed, severity: 'critical' | 'warning'): AlertHookPayload {
  const parts: string[] = [];
  if (embed.description) parts.push(embed.description);
  for (const field of embed.fields) parts.push(`**${field.name}**\n${field.value}`);
  const trailer = [embed.footer?.text, embed.timestamp].filter(Boolean).join(' · ');
  if (trailer) parts.push(trailer);
  return { severity, title: embed.title, text: parts.join('\n\n'), tenant: ALERT_TENANT };
}

/** One structured log line per alert, written BEFORE any POST and whatever its severity: the
 * durable "what did the system decide to alert about" record, queryable in Logs Insights with
 * `filter @message like "alert-notification"`. */
function logAlert(embed: AlertEmbed, severity: string, delivery: 'hub' | 'log-only'): void {
  logger.info('alert-notification', {
    title: embed.title,
    severity,
    delivery,
    footer: embed.footer?.text,
    fieldNames: embed.fields.map((f) => f.name),
    timestamp: embed.timestamp,
  });
}

/**
 * Sends each warning/critical embed to the hub alert hook; logs info/success ones only. Never throws:
 * every failure (missing env, SSM read, network, non-2xx) is logged as an error and the caller's main
 * job continues, so a broken alert path can never break a collector/scheduler.
 */
export interface PostAlertOptions {
  /** Log every embed without posting it, whatever its severity. For periodic summaries that would
   * otherwise open a duplicate hub incident on every run while a problem persists. */
  logOnly?: boolean;
}

export async function postAlertEmbeds(embeds: AlertEmbed[], options: PostAlertOptions = {}): Promise<void> {
  for (const embed of embeds) {
    const severity = severityForColor(embed.color);
    if (options.logOnly || (severity !== 'critical' && severity !== 'warning')) {
      logAlert(embed, severity ?? `unknown(${embed.color})`, 'log-only');
      continue;
    }
    logAlert(embed, severity, 'hub');
    try {
      const hookUrl = await fetchCachedHookUrl();
      const res = await fetch(hookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(toAlertHookPayload(embed, severity)),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '(could not read response body)');
        throw new Error(`Alert hook returned ${res.status}: ${body.slice(0, 500)}`);
      }
    } catch (err) {
      logger.error('alertHook: failed to deliver alert to the hub (ignored, does not break the main job)', { title: embed.title, err });
    }
  }
}
