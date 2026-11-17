/**
 * Minimal logger: emits structured JSON logs to stdout (level/message/context/timestamp).
 * Lambda automatically forwards stdout to CloudWatch Logs — no need for an external library
 * (pino/winston). CloudWatch Logs Insights can query directly by JSON field (e.g. `fields level, message`).
 *
 * `correlationId` is a TOP-LEVEL field, not nested inside `context` — the OpenTelemetry Logs Data
 * Model requires trace/correlation identifiers to be dedicated top-level LogRecord fields
 * precisely so a query engine can filter/join on them directly (`fields correlationId` in
 * CloudWatch Logs Insights) without having to reach into a variably-shaped nested object first.
 * Set once per Lambda invocation via `withCorrelationId()` (called at the top of `router.ts`); every
 * `logger.*` call for the rest of that invocation automatically carries it — callers do not pass
 * it manually on every log line.
 */

type LogLevel = 'info' | 'warn' | 'error';

/**
 * Invocation-scoped correlation id, set once per Lambda invocation. Lambda execution environments
 * are reused across invocations but NEVER concurrently for the same environment (a single Node.js
 * process handles one invocation at a time) — a module-scope variable is safe here, the same
 * assumption every other module-scope cache in this codebase already relies on (see
 * `ec2-state-manager-client.ts`'s `cachedTokenPromise`).
 */
let currentCorrelationId: string | undefined;

/** Sets the correlation id for the remainder of this invocation. Call once, at the top of the
 * handler, before any other `logger.*` call. */
export function setCorrelationId(id: string | undefined): void {
  currentCorrelationId = id;
}

/** Reads back the correlation id set by `setCorrelationId()` — used by handlers that need to
 * forward the SAME id downstream (e.g. `actions-execute.ts` attaching it to the
 * `ActionExecutionRequest` it sends to `action-execution-fn`), rather than minting a second,
 * different one. */
export function getCorrelationId(): string | undefined {
  return currentCorrelationId;
}

function write(level: LogLevel, message: string, context?: unknown): void {
  const entry: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    level,
    message,
  };
  if (currentCorrelationId) entry.correlationId = currentCorrelationId;
  if (context !== undefined) {
    entry[level === 'error' ? 'error' : 'context'] = serializeContext(context);
  }

  console.log(JSON.stringify(entry));
}

function serializeContext(context: unknown): unknown {
  if (context instanceof Error) {
    return { name: context.name, message: context.message, stack: context.stack };
  }
  return context;
}

export const logger = {
  info(message: string, context?: unknown): void {
    write('info', message, context);
  },
  warn(message: string, context?: unknown): void {
    write('warn', message, context);
  },
  error(message: string, context?: unknown): void {
    write('error', message, context);
  },
};
