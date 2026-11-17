import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from 'aws-lambda';
import { MAX_LOG_EVENTS_PER_PAGE } from '@ops-dashboard/shared';
import { ok } from '../../shared-kernel/response.js';
import { badRequest } from '../../shared-kernel/errors.js';
import { queryLogEvents } from './cloudwatch-logs-viewer-service.js';

/** Max time range for a SINGLE query. `FilterLogEvents` scans by time, so a range spanning several
 * months on a large log group would hit the Lambda timeout and return an endless chain of
 * empty-page-with-`nextToken` — the user would just see a spinner hang. Enforce the limit up front
 * so they get a clear reason. */
const MAX_RANGE_MS = 7 * 24 * 60 * 60 * 1000;

const DEFAULT_RANGE_MS = 60 * 60 * 1000;
const DEFAULT_LIMIT = 200;

/** Parses a positive-integer-shaped parameter. Returns `undefined` when the parameter is absent
 * (so the caller applies its default), throws 400 when it IS present but malformed — silently
 * ignoring a bad value would return data for a different time range than what the user asked for. */
function parseIntegerParam(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw badRequest(`Parameter "${name}" must be an integer (epoch milliseconds): "${raw}"`);
  }
  return value;
}

/**
 * `GET /logs/events` — reads real log events for one log group. Read-only, so it only requires
 * being signed in (the router already calls `verifyEntraToken()`); it does NOT gate on
 * `isOperatorMember()`: the operator gate is defined in Phase 1 for MUTATE actions, and reusing it
 * for a read route would dilute its meaning.
 */
export async function handler(event: LambdaFunctionURLEvent): Promise<LambdaFunctionURLResult> {
  const params = event.queryStringParameters ?? {};

  const logGroupName = params.logGroupName;
  if (!logGroupName) {
    throw badRequest('Missing required parameter: logGroupName');
  }

  const now = Date.now();
  const endTime = parseIntegerParam(params.endTime, 'endTime') ?? now;
  const startTime = parseIntegerParam(params.startTime, 'startTime') ?? endTime - DEFAULT_RANGE_MS;

  if (startTime >= endTime) {
    throw badRequest(`startTime (${startTime}) must be less than endTime (${endTime})`);
  }
  if (endTime - startTime > MAX_RANGE_MS) {
    throw badRequest('The maximum query time range is 7 days — please narrow the range you want to view.');
  }

  const limit = parseIntegerParam(params.limit, 'limit') ?? DEFAULT_LIMIT;
  if (limit <= 0 || limit > MAX_LOG_EVENTS_PER_PAGE) {
    throw badRequest(`Parameter "limit" must be in the range 1..${MAX_LOG_EVENTS_PER_PAGE}: ${limit}`);
  }

  const page = await queryLogEvents({
    logGroupName,
    startTime,
    endTime,
    limit,
    filterPattern: params.filterPattern,
    nextToken: params.nextToken,
  });
  return ok(event, page);
}
