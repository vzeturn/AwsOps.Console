import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../config.js', () => ({
  config: {
    allowedOrigins: [],
    entraTenantId: 'test-tenant',
    entraClientId: 'test-client',
    allowedGroupIds: [],
    awsRegion: 'ap-southeast-1',
    costCacheParamName: 'test-cost-cache-param',
    assessmentBucketName: 'test-assessment-bucket',
    ec2StateManagerServiceTokenParamName: 'test-service-token-param',
    ec2StateManagerFunctionUrl: 'https://example.invalid/',
    actionExecutionFunctionName: 'test-action-execution-fn',
  },
  corsHeaders: () => ({}),
}));

const cloudwatchLogsSendMock = vi.fn();

vi.mock('@aws-sdk/client-cloudwatch-logs', () => ({
  CloudWatchLogsClient: vi.fn().mockImplementation(() => ({ send: cloudwatchLogsSendMock })),
  DescribeLogGroupsCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'DescribeLogGroups', input })),
  PutRetentionPolicyCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'PutRetentionPolicy', input })),
}));

const { executeCloudWatchLogRetention } = await import('./cloudwatch-log-retention-action-service.js');

beforeEach(() => {
  cloudwatchLogsSendMock.mockReset();
});

describe('executeCloudWatchLogRetention', () => {
  it('success: log group has no retention yet -> PutRetentionPolicy 90 days, returns outcome success', async () => {
    cloudwatchLogsSendMock.mockImplementation(async (command: { __type?: string }) => {
      if (command.__type === 'DescribeLogGroups') return { logGroups: [{ logGroupName: '/aws/lambda/foo', retentionInDays: undefined }] };
      if (command.__type === 'PutRetentionPolicy') return {};
      throw new Error('unexpected');
    });

    const result = await executeCloudWatchLogRetention('/aws/lambda/foo');

    expect(result).toEqual({ outcome: 'success', newRetentionDays: 90 });
  });

  it('rejected: log group does not exist', async () => {
    cloudwatchLogsSendMock.mockResolvedValue({ logGroups: [] });

    const result = await executeCloudWatchLogRetention('/aws/lambda/missing');

    expect(result.outcome).toBe('rejected');
  });

  it('rejected: log group ALREADY has a retention policy at execution time — does NOT overwrite', async () => {
    cloudwatchLogsSendMock.mockResolvedValue({ logGroups: [{ logGroupName: '/aws/lambda/foo', retentionInDays: 30 }] });

    const result = await executeCloudWatchLogRetention('/aws/lambda/foo');

    expect(result.outcome).toBe('rejected');
    expect(cloudwatchLogsSendMock).toHaveBeenCalledTimes(1); // DescribeLogGroups only
  });

  it('failure: PutRetentionPolicy throw -> outcome failure', async () => {
    cloudwatchLogsSendMock.mockImplementation(async (command: { __type?: string }) => {
      if (command.__type === 'DescribeLogGroups') return { logGroups: [{ logGroupName: '/aws/lambda/foo', retentionInDays: undefined }] };
      if (command.__type === 'PutRetentionPolicy') throw new Error('AWS throttled');
      throw new Error('unexpected');
    });

    const result = await executeCloudWatchLogRetention('/aws/lambda/foo');

    expect(result.outcome).toBe('failure');
    expect(result.reason).toContain('AWS throttled');
  });

  it('failure: DescribeLogGroups throw -> outcome failure', async () => {
    cloudwatchLogsSendMock.mockRejectedValue(new Error('network error'));

    const result = await executeCloudWatchLogRetention('/aws/lambda/foo');

    expect(result.outcome).toBe('failure');
  });
});
