import { randomUUID } from 'node:crypto';
import type { LambdaFunctionURLEvent } from 'aws-lambda';

/**
 * Request correlation id — generated ONCE per inbound request in `router.ts` and threaded through
 * every downstream hop (structured log lines, the synchronous `lambda:InvokeFunction` payload to
 * `action-execution-fn`, and the resulting `Action_Audit_Record`) so a single operator-visible
 * failure can be traced across all 3 without grepping timestamps across log groups (design.md
 * D07-C06/D07-C08 — OpenTelemetry Logs Data Model requires a correlation identifier on every
 * LogRecord).
 *
 * NOT a replacement for distributed tracing (X-Ray/OpenTelemetry spans, still not implemented —
 * see design.md D07-C07) — this is a much cheaper, zero-new-dependency first step: one opaque
 * string, generated with the platform's own `crypto.randomUUID()` (no new package), propagated by
 * hand through the 2-hop call chain that actually exists today (router -> action-execution-fn).
 *
 * `x-correlation-id` request header support: if the CALLER already provides one (e.g. a future
 * integration test harness correlating its own request to the resulting audit record), it is
 * reused instead of minting a new one — but only when it looks like a plausible id (bounded
 * length, restricted charset) to avoid a hostile caller injecting an arbitrarily large or
 * control-character-laden string into every subsequent log line.
 */

const MAX_INBOUND_ID_LENGTH = 128;
const VALID_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

function readHeaderCaseInsensitive(
  headers: Record<string, string | undefined> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : undefined;
}

/**
 * Resolves the correlation id for an inbound `LambdaFunctionURLEvent`: reuses a valid
 * caller-supplied `x-correlation-id` header, otherwise mints a fresh UUID v4.
 */
export function resolveCorrelationId(event: LambdaFunctionURLEvent): string {
  const inbound = readHeaderCaseInsensitive(event.headers, 'x-correlation-id');
  if (inbound && inbound.length <= MAX_INBOUND_ID_LENGTH && VALID_ID_PATTERN.test(inbound)) {
    return inbound;
  }
  return randomUUID();
}
