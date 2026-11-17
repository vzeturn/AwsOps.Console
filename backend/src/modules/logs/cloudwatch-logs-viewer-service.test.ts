import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HttpError } from '../../shared-kernel/errors.js';

vi.mock('../../config.js', () => ({
  config: {
    allowedOrigins: [],
    entraTenantId: 'test-tenant',
    entraClientId: 'test-client',
    allowedGroupIds: [],
    awsRegion: 'ap-southeast-1',
    assessmentBucketName: 'test-assessment-bucket',
  },
  corsHeaders: () => ({}),
}));

const cloudwatchLogsSendMock = vi.fn();

vi.mock('@aws-sdk/client-cloudwatch-logs', () => ({
  CloudWatchLogsClient: vi.fn().mockImplementation(() => ({ send: cloudwatchLogsSendMock })),
  DescribeLogGroupsCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'DescribeLogGroups', input })),
  FilterLogEventsCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'FilterLogEvents', input })),
}));

const { listLogGroups, queryLogEvents } = await import('./cloudwatch-logs-viewer-service.js');

/** AWS SDK v3 identifies errors via `err.name`, not the error class — reproduce that exact behavior in the test. */
function awsError(name: string, message = 'aws error'): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

const BASE_QUERY = {
  logGroupName: '/aws/lambda/foo',
  startTime: 1_700_000_000_000,
  endTime: 1_700_003_600_000,
  limit: 200,
};

beforeEach(() => {
  cloudwatchLogsSendMock.mockReset();
});

describe('listLogGroups', () => {
  it('merges multiple nextToken pages, sorts A→Z, missing retentionInDays → null', async () => {
    cloudwatchLogsSendMock
      .mockResolvedValueOnce({
        logGroups: [{ logGroupName: '/zebra', retentionInDays: 30, storedBytes: 100 }],
        nextToken: 'page-2',
      })
      .mockResolvedValueOnce({
        logGroups: [
          { logGroupName: '/alpha', storedBytes: 50 },
          // A log group with no name is unusable data — it must be dropped, never leak out to the UI.
          { storedBytes: 999 },
        ],
      });

    const result = await listLogGroups();

    expect(cloudwatchLogsSendMock).toHaveBeenCalledTimes(2);
    expect(result.truncated).toBe(false);
    expect(result.groups).toEqual([
      { logGroupName: '/alpha', retentionInDays: null, storedBytes: 50 },
      { logGroupName: '/zebra', retentionInDays: 30, storedBytes: 100 },
    ]);
  });

  it('exceeds the 500 log group cap while still having a nextToken → stops early, truncated true, cut to exactly 500', async () => {
    const page = (prefix: string) =>
      Array.from({ length: 300 }, (_, i) => ({
        logGroupName: `${prefix}-${String(i).padStart(3, '0')}`,
        storedBytes: 0,
      }));
    cloudwatchLogsSendMock
      .mockResolvedValueOnce({ logGroups: page('a'), nextToken: 'page-2' })
      .mockResolvedValueOnce({ logGroups: page('b'), nextToken: 'page-3' });

    const result = await listLogGroups();

    // Stops right after page 2 (600 > 500), does NOT call page 3.
    expect(cloudwatchLogsSendMock).toHaveBeenCalledTimes(2);
    expect(result.groups).toHaveLength(500);
    expect(result.truncated).toBe(true);
  });

  it('exactly 500 log groups and NO nextToken remaining → truncated false (complete list)', async () => {
    cloudwatchLogsSendMock.mockResolvedValueOnce({
      logGroups: Array.from({ length: 500 }, (_, i) => ({ logGroupName: `/g-${i}`, storedBytes: 0 })),
    });

    const result = await listLogGroups();

    expect(result.groups).toHaveLength(500);
    expect(result.truncated).toBe(false);
  });

  it('DescribeLogGroups is throttled → HttpError 429 (does NOT swallow the error and return an empty list)', async () => {
    cloudwatchLogsSendMock.mockRejectedValue(awsError('ThrottlingException'));

    await expect(listLogGroups()).rejects.toThrow(HttpError);
    await expect(listLogGroups()).rejects.toMatchObject({ statusCode: 429 });
  });
});

describe('queryLogEvents', () => {
  it('returns events + nextToken, drops events missing eventId/message/timestamp', async () => {
    cloudwatchLogsSendMock.mockResolvedValueOnce({
      events: [
        { eventId: 'e1', timestamp: 1_700_000_001_000, logStreamName: 'stream-a', message: 'hello' },
        { timestamp: 1_700_000_002_000, message: 'missing eventId' },
        { eventId: 'e3', message: 'missing timestamp' },
      ],
      nextToken: 'next-1',
    });

    const page = await queryLogEvents(BASE_QUERY);

    expect(page.events).toEqual([
      { eventId: 'e1', timestamp: 1_700_000_001_000, logStreamName: 'stream-a', message: 'hello' },
    ]);
    expect(page.nextToken).toBe('next-1');
    expect(page.truncatedMessageCount).toBe(0);
  });

  it('empty filterPattern → does NOT send the filterPattern field to AWS (empty string is not "no filter")', async () => {
    cloudwatchLogsSendMock.mockResolvedValueOnce({ events: [] });

    await queryLogEvents({ ...BASE_QUERY, filterPattern: '' });

    const command = cloudwatchLogsSendMock.mock.calls[0][0] as { input: Record<string, unknown> };
    expect(command.input.filterPattern).toBeUndefined();
    expect(command.input.logGroupName).toBe('/aws/lambda/foo');
    expect(command.input.limit).toBe(200);
  });

  it('message longer than 4000 characters → truncates, counts truncatedMessageCount correctly', async () => {
    cloudwatchLogsSendMock.mockResolvedValueOnce({
      events: [
        { eventId: 'e1', timestamp: 1, logStreamName: 's', message: 'x'.repeat(5000) },
        { eventId: 'e2', timestamp: 2, logStreamName: 's', message: 'y'.repeat(4000) },
        { eventId: 'e3', timestamp: 3, logStreamName: 's', message: 'z'.repeat(4001) },
      ],
    });

    const page = await queryLogEvents(BASE_QUERY);

    expect(page.truncatedMessageCount).toBe(2);
    expect(page.events[0].message).toBe('x'.repeat(4000) + '… [truncated]');
    expect(page.events[1].message).toBe('y'.repeat(4000));
  });

  it('EMPTY page but with a nextToken → returns the nextToken as-is, does NOT call the next page itself', async () => {
    cloudwatchLogsSendMock.mockResolvedValueOnce({ events: [], nextToken: 'still-more' });

    const page = await queryLogEvents(BASE_QUERY);

    expect(cloudwatchLogsSendMock).toHaveBeenCalledTimes(1);
    expect(page.events).toEqual([]);
    expect(page.nextToken).toBe('still-more');
  });

  it('log group does not exist → HttpError 404 with the log group name', async () => {
    cloudwatchLogsSendMock.mockRejectedValue(awsError('ResourceNotFoundException'));

    await expect(queryLogEvents(BASE_QUERY)).rejects.toMatchObject({
      statusCode: 404,
      message: expect.stringContaining('/aws/lambda/foo'),
    });
  });

  it('filter pattern has invalid syntax → HttpError 400 keeps AWS\'s original message', async () => {
    cloudwatchLogsSendMock.mockRejectedValue(awsError('InvalidParameterException', 'Invalid filter pattern'));

    await expect(queryLogEvents(BASE_QUERY)).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('Invalid filter pattern'),
    });
  });

  it('AWS error outside the 3 known groups → rethrown UNCHANGED to fall through to 500 (not pretended to be an input error)', async () => {
    const original = awsError('ServiceUnavailableException');
    cloudwatchLogsSendMock.mockRejectedValue(original);

    await expect(queryLogEvents(BASE_QUERY)).rejects.toBe(original);
  });
});
