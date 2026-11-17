import { describe, it, expect, vi, beforeEach } from 'vitest';

// Task 6.10: unit test for serverless-collector.ts
// The collector reads the region directly from process.env.AWS_REGION (the Lambda runtime always
// sets this variable itself) — set it before importing the module; no more mocking config.ts
// (the collector doesn't import config.ts).
process.env.AWS_REGION = 'ap-southeast-1';

const lambdaSendMock = vi.fn();
const cloudwatchSendMock = vi.fn();

vi.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: vi.fn().mockImplementation(() => ({ send: lambdaSendMock })),
  ListFunctionsCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
}));

vi.mock('@aws-sdk/client-cloudwatch', () => ({
  CloudWatchClient: vi.fn().mockImplementation(() => ({ send: cloudwatchSendMock })),
  GetMetricDataCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
}));

// Import after the mocks are declared (vi.mock is hoisted to the top by vitest).
const { collectServerless } = await import('./serverless-collector.js');

beforeEach(() => {
  lambdaSendMock.mockReset();
  cloudwatchSendMock.mockReset();
});

describe('collectServerless', () => {
  it('returns the correct RawLambdaMetrics matching the mocked memory/invocations/duration/errors values from CloudWatch', async () => {
    lambdaSendMock.mockResolvedValue({
      Functions: [
        {
          FunctionName: 'my-fn-1',
          MemorySize: 256,
        },
      ],
    });
    cloudwatchSendMock.mockResolvedValue({
      MetricDataResults: [
        { Id: 'inv_my_fn_1', Values: [1234] },
        { Id: 'dur_my_fn_1', Values: [88.5] },
        { Id: 'err_my_fn_1', Values: [3] },
      ],
    });

    const result = await collectServerless();

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      functionName: 'my-fn-1',
      region: 'ap-southeast-1',
      memoryMb: 256,
      avgDurationMs: 88.5,
      invocationsInPeriod: 1234,
      errorsInPeriod: 3,
    });
  });

  it('returns [] (does not throw) when ListFunctions fails', async () => {
    lambdaSendMock.mockRejectedValue(new Error('AccessDenied'));

    const result = await collectServerless();

    expect(result).toEqual([]);
    expect(cloudwatchSendMock).not.toHaveBeenCalled();
  });
});
