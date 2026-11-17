import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LambdaFunctionURLEvent } from 'aws-lambda';
import type { LogEventsPage } from '@ops-dashboard/shared';
import { HttpError } from '../../shared-kernel/errors.js';

vi.mock('../../config.js', () => ({
  config: { allowedOrigins: [] },
  corsHeaders: () => ({}),
}));

// Mock the service to test the handler's parameter validation in isolation — the AWS-calling
// logic is already covered in cloudwatch-logs-viewer-service.test.ts.
const queryLogEventsMock = vi.fn();
vi.mock('./cloudwatch-logs-viewer-service.js', () => ({
  queryLogEvents: queryLogEventsMock,
}));

const { handler } = await import('./get-log-events.js');

function buildEvent(queryStringParameters: Record<string, string> | undefined): LambdaFunctionURLEvent {
  return {
    headers: {},
    rawPath: '/logs/events',
    queryStringParameters,
    requestContext: { http: { method: 'GET' } },
  } as unknown as LambdaFunctionURLEvent;
}

const EMPTY_PAGE: LogEventsPage = { events: [], truncatedMessageCount: 0 };

beforeEach(() => {
  queryLogEventsMock.mockReset();
  queryLogEventsMock.mockResolvedValue(EMPTY_PAGE);
});

describe('get-log-events handler', () => {
  it('valid parameters → calls queryLogEvents with the right arguments, returns 200 with the correct page', async () => {
    const page: LogEventsPage = {
      events: [{ eventId: 'e1', timestamp: 1_700_000_000_000, logStreamName: 's', message: 'hello' }],
      nextToken: 'tok',
      truncatedMessageCount: 0,
    };
    queryLogEventsMock.mockResolvedValue(page);

    const result = await handler(
      buildEvent({
        logGroupName: '/aws/lambda/foo',
        startTime: '1700000000000',
        endTime: '1700003600000',
        limit: '500',
        filterPattern: 'ERROR',
        nextToken: 'prev-tok',
      }),
    );

    expect(queryLogEventsMock).toHaveBeenCalledWith({
      logGroupName: '/aws/lambda/foo',
      startTime: 1_700_000_000_000,
      endTime: 1_700_003_600_000,
      limit: 500,
      filterPattern: 'ERROR',
      nextToken: 'prev-tok',
    });
    const typedResult = result as { statusCode: number; body: string };
    expect(typedResult.statusCode).toBe(200);
    expect(JSON.parse(typedResult.body)).toEqual(page);
  });

  it('no startTime/endTime passed → defaults to a 1-hour window ending now, default limit 200', async () => {
    const before = Date.now();
    await handler(buildEvent({ logGroupName: '/aws/lambda/foo' }));
    const after = Date.now();

    const args = queryLogEventsMock.mock.calls[0][0] as { startTime: number; endTime: number; limit: number };
    expect(args.endTime).toBeGreaterThanOrEqual(before);
    expect(args.endTime).toBeLessThanOrEqual(after);
    expect(args.endTime - args.startTime).toBe(60 * 60 * 1000);
    expect(args.limit).toBe(200);
  });

  it('missing logGroupName → HttpError 400, service not called', async () => {
    await expect(handler(buildEvent(undefined))).rejects.toThrow(HttpError);
    await expect(handler(buildEvent({}))).rejects.toMatchObject({ statusCode: 400 });
    expect(queryLogEventsMock).not.toHaveBeenCalled();
  });

  it.each([
    ['startTime is not an integer', { logGroupName: '/g', startTime: 'yesterday' }],
    ['limit is not an integer', { logGroupName: '/g', limit: '12.5' }],
    ['startTime >= endTime', { logGroupName: '/g', startTime: '1700003600000', endTime: '1700000000000' }],
    ['range > 7 days', { logGroupName: '/g', startTime: '1700000000000', endTime: '1700700000000' }],
    ['limit exceeds the 500 cap', { logGroupName: '/g', limit: '501' }],
    ['limit is 0', { logGroupName: '/g', limit: '0' }],
  ])('%s → HttpError 400, service not called', async (_label, params) => {
    await expect(handler(buildEvent(params))).rejects.toMatchObject({ statusCode: 400 });
    expect(queryLogEventsMock).not.toHaveBeenCalled();
  });

  it('range of exactly 7 days → valid (upper bound is inclusive)', async () => {
    const endTime = 1_700_000_000_000;
    const startTime = endTime - 7 * 24 * 60 * 60 * 1000;

    await handler(buildEvent({ logGroupName: '/g', startTime: String(startTime), endTime: String(endTime) }));

    expect(queryLogEventsMock).toHaveBeenCalledTimes(1);
  });
});
