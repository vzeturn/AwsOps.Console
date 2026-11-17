import { describe, it, expect, vi, beforeEach } from 'vitest';

// The collector reads the region directly from process.env.AWS_REGION (the Lambda runtime always
// sets this automatically) — set it before importing the module; don't mock config.ts (the collector doesn't import config.ts).
process.env.AWS_REGION = 'ap-southeast-1';

const cloudwatchLogsSendMock = vi.fn();

vi.mock('@aws-sdk/client-cloudwatch-logs', () => ({
  CloudWatchLogsClient: vi.fn().mockImplementation(() => ({ send: cloudwatchLogsSendMock })),
  DescribeLogGroupsCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
}));

const { collectCloudWatchLogGroups } = await import('./cloudwatch-logs-collector.js');

beforeEach(() => {
  cloudwatchLogsSendMock.mockReset();
});

describe('collectCloudWatchLogGroups', () => {
  it('returns retentionInDays=null for a log group with no retention policy set ("Never Expire")', async () => {
    cloudwatchLogsSendMock.mockResolvedValue({
      logGroups: [
        { logGroupName: '/aws/lambda/foo', retentionInDays: undefined, storedBytes: 123456 },
        { logGroupName: '/aws/lambda/bar', retentionInDays: 30, storedBytes: 999 },
      ],
    });

    const result = await collectCloudWatchLogGroups();

    expect(result).toHaveLength(2);
    expect(result).toContainEqual({
      logGroupName: '/aws/lambda/foo',
      region: 'ap-southeast-1',
      retentionInDays: null,
      storedBytes: 123456,
    });
    expect(result).toContainEqual({
      logGroupName: '/aws/lambda/bar',
      region: 'ap-southeast-1',
      retentionInDays: 30,
      storedBytes: 999,
    });
  });

  it('paginates via nextToken until no log groups remain', async () => {
    cloudwatchLogsSendMock
      .mockResolvedValueOnce({
        logGroups: [{ logGroupName: '/aws/lambda/page1', storedBytes: 1 }],
        nextToken: 'token-1',
      })
      .mockResolvedValueOnce({
        logGroups: [{ logGroupName: '/aws/lambda/page2', storedBytes: 2 }],
      });

    const result = await collectCloudWatchLogGroups();

    expect(cloudwatchLogsSendMock).toHaveBeenCalledTimes(2);
    expect(result.map((r) => r.logGroupName)).toEqual(['/aws/lambda/page1', '/aws/lambda/page2']);
  });

  it('DescribeLogGroups fails -> returns empty, does not throw', async () => {
    cloudwatchLogsSendMock.mockRejectedValue(new Error('AccessDenied'));

    const result = await collectCloudWatchLogGroups();

    expect(result).toEqual([]);
  });

  it('skips a log group missing logGroupName', async () => {
    cloudwatchLogsSendMock.mockResolvedValue({
      logGroups: [{ logGroupName: undefined, storedBytes: 1 }, { logGroupName: '/aws/lambda/valid', storedBytes: 2 }],
    });

    const result = await collectCloudWatchLogGroups();

    expect(result).toHaveLength(1);
    expect(result[0].logGroupName).toBe('/aws/lambda/valid');
  });
});
