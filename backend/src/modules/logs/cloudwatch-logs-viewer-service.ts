import {
  DescribeLogGroupsCommand,
  FilterLogEventsCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import type { LogEventItem, LogEventsPage, LogGroupSummary, LogGroupsResponse } from '@ops-dashboard/shared';
import { badRequest, notFound, tooManyRequests } from '../../shared-kernel/errors.js';
import { getCloudWatchLogsClient } from '../../core/aws-clients.js';

/**
 * Reads REAL CloudWatch Logs events for the "Logs" tab — runs directly in the router Lambda (no
 * dedicated Lambda), following the same pattern as `threshold-history-service.ts` which serves
 * `GET /monitoring/history`.
 *
 * Uses `FilterLogEvents` for EVERY event query (even without a filter pattern — leaving
 * `filterPattern` blank makes AWS return every event in the time range). One single API in
 * exchange for one single IAM action `logs:FilterLogEvents`: no need for
 * `logs:GetLogEvents`/`logs:DescribeLogStreams`, and no two parallel code paths to keep in sync.
 *
 * Does NOT use CloudWatch Logs Insights (`StartQuery`/`GetQueryResults`): the async-polling model
 * is a poor fit for a Function URL's short request/response cycle, and Insights bills by GB of
 * data scanned — at odds with this dashboard's "$0 forever" architecture.
 */

const cloudwatchLogs = getCloudWatchLogsClient();

/** Cap on the number of log groups listed. The account currently has only a few dozen log groups,
 * but an uncapped `do...while` loop is a time bomb: as the log group count grows, it will both hit
 * the Lambda timeout and push the response past the Function URL's 6 MB limit. Hitting the cap
 * stops the loop and reports `truncated` to the user. */
const MAX_LOG_GROUPS = 500;

/** Cap on each message's length. Some logs (stack traces, JSON dumps) run tens of thousands of
 * characters long; 500 events like that is enough to blow past 6 MB. Truncate here, but COUNT how
 * many messages were truncated so the UI can say so clearly — silently swallowing content from
 * someone who's debugging is counterproductive. */
const MAX_MESSAGE_CHARS = 4000;
const TRUNCATION_SUFFIX = '… [truncated]';

export interface QueryLogEventsParams {
  logGroupName: string;
  /** Epoch milliseconds. */
  startTime: number;
  /** Epoch milliseconds. */
  endTime: number;
  limit: number;
  filterPattern?: string;
  nextToken?: string;
}

/** The AWS SDK v3 exception name lives in `err.name`; `instanceof` doesn't work because these
 * error classes are generated dynamically at runtime and are mocked in tests. */
function awsErrorName(err: unknown): string {
  return err instanceof Error ? err.name : '';
}

/**
 * Maps AWS errors to the correct HTTP status by CAUSE, instead of letting everything fall through
 * to 500. The three cases below are all consequences of user input or the pace of their clicks,
 * not system failures — returning 500 would send operators investigating in the wrong place.
 * Errors outside these 3 groups are rethrown UNCHANGED so `fail()` handles them as genuine system
 * errors (500 + `logger.error`).
 */
function mapAwsError(err: unknown, logGroupName?: string): unknown {
  switch (awsErrorName(err)) {
    case 'ResourceNotFoundException':
      return notFound(logGroupName ? `Log group not found: ${logGroupName}` : 'CloudWatch Logs resource not found');
    case 'InvalidParameterException':
      // Keep AWS's original message: it pinpoints where/why the filter pattern syntax is wrong
      // more precisely than any rewording of ours could.
      return badRequest(`Invalid log query parameter: ${err instanceof Error ? err.message : 'unknown'}`);
    case 'ThrottlingException':
    case 'LimitExceededException':
      return tooManyRequests('CloudWatch Logs is rate-limiting queries — please try again in a few seconds.');
    default:
      return err;
  }
}

function truncateMessage(message: string): { message: string; truncated: boolean } {
  if (message.length <= MAX_MESSAGE_CHARS) return { message, truncated: false };
  return { message: message.slice(0, MAX_MESSAGE_CHARS) + TRUNCATION_SUFFIX, truncated: true };
}

/**
 * Lists log groups for the user to pick from. Sorted A→Z on the backend because
 * `DescribeLogGroups` does NOT guarantee a stable order across pages — a list that jumps order on
 * every refetch is a real UX bug.
 *
 * DIFFERS from `collectors/cloudwatch-logs-collector.ts` in that it does NOT swallow errors to
 * return an empty array: that collector runs in the background and must survive so other
 * collectors can keep running, whereas this is a synchronous request the user is waiting on — a
 * fake empty list would be read as "this account has no log groups".
 */
export async function listLogGroups(): Promise<LogGroupsResponse> {
  const groups: LogGroupSummary[] = [];
  let nextToken: string | undefined;
  // `truncated` must mean "there WAS an unread page left when we stopped", NOT "we reached
  // MAX_LOG_GROUPS": an account with exactly 500 log groups and no further pages has a COMPLETE
  // list, and reporting truncated there would send the user looking for something that doesn't exist.
  let stoppedAtCap = false;

  try {
    do {
      const { logGroups = [], nextToken: token } = await cloudwatchLogs.send(
        new DescribeLogGroupsCommand({ nextToken }),
      );
      for (const lg of logGroups) {
        if (!lg.logGroupName) continue;
        groups.push({
          logGroupName: lg.logGroupName,
          retentionInDays: lg.retentionInDays ?? null,
          storedBytes: lg.storedBytes ?? 0,
        });
      }
      nextToken = token;
      if (nextToken && groups.length >= MAX_LOG_GROUPS) {
        stoppedAtCap = true;
        break;
      }
    } while (nextToken);
  } catch (err) {
    throw mapAwsError(err);
  }

  groups.sort((a, b) => a.logGroupName.localeCompare(b.logGroupName));
  return {
    groups: groups.slice(0, MAX_LOG_GROUPS),
    truncated: stoppedAtCap || groups.length > MAX_LOG_GROUPS,
  };
}

/**
 * Reads ONE page of log events. Returns exactly what AWS returns — deliberately does NOT loop to
 * "accumulate enough" events when a page is empty: `FilterLogEvents` scans by time window, so an
 * empty page with a `nextToken` is normal behavior, and an accumulating loop would hit the Lambda
 * timeout on a large log group. Recognizing "there's more data" is the client's responsibility,
 * based on `nextToken`.
 */
export async function queryLogEvents(params: QueryLogEventsParams): Promise<LogEventsPage> {
  const { logGroupName, startTime, endTime, limit, filterPattern, nextToken } = params;

  try {
    const response = await cloudwatchLogs.send(
      new FilterLogEventsCommand({
        logGroupName,
        startTime,
        endTime,
        limit,
        // An empty string is NOT "no filter" to AWS — omit the field entirely when the user hasn't entered one.
        filterPattern: filterPattern && filterPattern.length > 0 ? filterPattern : undefined,
        nextToken,
      }),
    );

    const events: LogEventItem[] = [];
    let truncatedMessageCount = 0;
    for (const e of response.events ?? []) {
      if (!e.eventId || e.message === undefined || e.timestamp === undefined) continue;
      const { message, truncated } = truncateMessage(e.message);
      if (truncated) truncatedMessageCount += 1;
      events.push({
        eventId: e.eventId,
        timestamp: e.timestamp,
        logStreamName: e.logStreamName ?? '',
        message,
      });
    }

    return { events, nextToken: response.nextToken, truncatedMessageCount };
  } catch (err) {
    throw mapAwsError(err, logGroupName);
  }
}
