import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';

// Feature: resource-actions-and-aurora-ui, Property 13: StateManager invocation never falls
// back to direct EC2 API calls
//
// For any mocked StateManager response (a { success: true, data: ActionResult, error: null }
// envelope with an arbitrary transitional currentState within 30s, a
// { success: false, data: null, error: {...} } envelope within 30s, or no response before the
// 30-second deadline), callEc2StateManager SHALL return { success: true, state: <passthrough
// currentState> } if and only if a success envelope was received within the deadline (never
// assumed to be the final converged state), and SHALL return { success: false, ... } for every
// error or timeout case -- and across all cases, no AWS SDK StartInstancesCommand/
// StopInstancesCommand SHALL ever be invoked.
//
// Validates: Requirements 9.1, 9.2, 9.3

vi.mock('../../config.js', () => ({
  config: {
    allowedOrigins: [],
    entraTenantId: 'test-tenant',
    entraClientId: 'test-client',
    allowedGroupIds: [],
    awsRegion: 'ap-southeast-1',
    costCacheParamName: 'test-cost-cache-param',
    assessmentBucketName: 'test-assessment-bucket',
    ec2StateManagerServiceTokenParamName: '/ops-dashboard/ec2-state-manager-token',
    ec2StateManagerFunctionUrl: 'https://example-function-url.lambda-url.ap-southeast-1.on.aws',
    actionExecutionFunctionName: 'test-action-execution-fn',
  },
  corsHeaders: () => ({}),
}));

// callEc2StateManager reads the shared secret via SSMClient/GetParameterCommand, cached at module
// scope (cold start) -- resolve once with a fixed token. Subsequent calls within this module
// instance reuse the cached promise, which is fine here since this test never asserts on how many
// times SSM was called.
const ssmSendMock = vi.fn(async () => ({ Parameter: { Value: 'test-secret-token' } }));

vi.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: vi.fn().mockImplementation(() => ({ send: ssmSendMock })),
  GetParameterCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'getParameter', input })),
}));

// Defensive belt-and-suspenders check mirroring the static import-check test (Task 16.5) -- the
// source file (per its own header comment, verified by inspection: it only imports
// `@aws-sdk/client-ssm` and `../config.js`) never imports `@aws-sdk/client-ec2` at all. These spies
// should therefore NEVER be invoked across any case below -- the core "no direct EC2 API fallback"
// assertion for this property.
const startInstancesMock = vi.fn();
const stopInstancesMock = vi.fn();

vi.mock('@aws-sdk/client-ec2', () => ({
  EC2Client: vi.fn().mockImplementation(() => ({ send: vi.fn() })),
  StartInstancesCommand: startInstancesMock,
  StopInstancesCommand: stopInstancesMock,
}));

const { callEc2StateManager } = await import('./ec2-state-manager-client.js');

beforeEach(() => {
  ssmSendMock.mockClear();
  startInstancesMock.mockClear();
  stopInstancesMock.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function assertNoDirectEc2Fallback() {
  expect(startInstancesMock).not.toHaveBeenCalled();
  expect(stopInstancesMock).not.toHaveBeenCalled();
}

describe('callEc2StateManager (Property 13)', () => {
  it('passes through the success envelope currentState unmodified, for any transitional state', async () => {
    const currentStateArb = fc.oneof(
      fc.constantFrom('pending', 'stopping', 'running', 'stopped', 'shutting-down'),
      fc.string(),
    );

    await fc.assert(
      fc.asyncProperty(currentStateArb, async (currentState) => {
        vi.stubGlobal(
          'fetch',
          vi.fn(async () => ({
            ok: true,
            status: 200,
            json: async () => ({
              success: true,
              data: {
                instanceId: 'i-abc123',
                region: 'ap-southeast-1',
                previousState: 'stopped',
                currentState,
              },
              error: null,
            }),
          })),
        );

        const result = await callEc2StateManager('i-abc123', 'ap-southeast-1', 'start');

        // Passed through EXACTLY as received -- never assumed to be the final converged state.
        expect(result).toEqual({ success: true, state: currentState });
      }),
      { numRuns: 100 },
    );

    assertNoDirectEc2Fallback();
  });

  it('returns success:false with the envelope error message for an error envelope', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          success: false,
          data: null,
          error: { code: 'CONFLICT', message: 'Instance already running' },
        }),
      })),
    );

    const result = await callEc2StateManager('i-abc123', 'ap-southeast-1', 'start');

    expect(result).toEqual({ success: false, error: 'Instance already running' });
    assertNoDirectEc2Fallback();
  });

  it('returns success:false for a non-2xx HTTP status, even with a well-formed body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 403,
        json: async () => ({
          success: true,
          data: {
            instanceId: 'i-abc123',
            region: 'ap-southeast-1',
            previousState: 'stopped',
            currentState: 'pending',
          },
          error: null,
        }),
      })),
    );

    const result = await callEc2StateManager('i-abc123', 'ap-southeast-1', 'start');

    expect(result.success).toBe(false);
    expect(result.error).toContain('403');
    assertNoDirectEc2Fallback();
  });

  it('returns success:false for a generic network error (fetch rejects)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );

    const result = await callEc2StateManager('i-abc123', 'ap-southeast-1', 'start');

    expect(result.success).toBe(false);
    expect(result.error).toContain('network down');
    assertNoDirectEc2Fallback();
  });

  it('returns success:false with a timeout message when there is no response before the 30s deadline', async () => {
    vi.useFakeTimers();

    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, options: { signal: AbortSignal }) => {
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        });
      }),
    );

    const resultPromise = callEc2StateManager('i-abc123', 'ap-southeast-1', 'stop');

    // Fast-forward past the 30_000ms AbortController timeout without waiting 30 real seconds.
    await vi.advanceTimersByTimeAsync(30_001);

    const result = await resultPromise;

    expect(result.success).toBe(false);
    expect(result.error).toContain('30000ms');
    assertNoDirectEc2Fallback();
  });
});
