import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from 'aws-lambda';
import { corsHeaders } from '../config.js';
import { HttpError } from './errors.js';
import { logger } from './logger.js';
import { securityHeaders } from './securityHeaders.js';
import { problemTypeFor } from './problemTypes.js';

function readOrigin(event: LambdaFunctionURLEvent): string | undefined {
  return event.headers?.origin ?? event.headers?.Origin;
}

export function ok<T>(event: LambdaFunctionURLEvent, data: T, headers: Record<string, string> = {}): LambdaFunctionURLResult {
  return {
    statusCode: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...securityHeaders(),
      ...corsHeaders(readOrigin(event)),
      ...headers,
    },
    body: JSON.stringify(data),
  };
}

/**
 * Error body follows RFC 9457 (`application/problem+json`) — `type`/`title`/`status` are always
 * present, `detail` carries the same free-text message the `error` field used to carry alone
 * (design.md D12-C05/D12-C06). `instance` is the request's correlation id (see
 * `lib/correlationId.ts`) when one was generated for this request — lets an operator match a
 * specific error response back to the exact CloudWatch log lines for that request.
 *
 * `error` is KEPT alongside `detail` for backward compatibility — `frontend/src/api/client.ts`
 * currently reads `body.error` directly; changing the content-type/shape without keeping this
 * field would silently break every existing error-handling code path in the SPA. New client code
 * should read `detail`/`type`, not `error`.
 */
export function fail(err: unknown, event: LambdaFunctionURLEvent, correlationId?: string): LambdaFunctionURLResult {
  const statusCode = err instanceof HttpError ? err.statusCode : 500;
  const message = err instanceof Error ? err.message : 'Internal error';
  if (statusCode === 500) logger.error('Unhandled error', { err, correlationId });

  const { type, title } = problemTypeFor(statusCode);
  const body: Record<string, unknown> = {
    type,
    title,
    status: statusCode,
    detail: message,
    // Backward-compat field — see doc comment above.
    error: message,
  };
  if (correlationId) body.instance = `urn:ops-dashboard:request:${correlationId}`;

  return {
    statusCode,
    headers: {
      'content-type': 'application/problem+json; charset=utf-8',
      ...securityHeaders(),
      ...corsHeaders(readOrigin(event)),
    },
    body: JSON.stringify(body),
  };
}
