import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';

// Feature: resource-actions-and-aurora-ui, Property 9: S3 lifecycle apply is guarded by existing-policy and error checks

// s3-lifecycle-action-service.ts creates an S3Client at module scope reading config.awsRegion —
// mock config.js following the same pattern as alert-service.property7.test.ts /
// monitoring-service.property1.test.ts so importing doesn't throw due to a missing required env
// var.
vi.mock('../../config.js', () => ({
  config: {
    allowedOrigins: [],
    entraTenantId: 'test-tenant',
    entraClientId: 'test-client',
    allowedGroupIds: [],
    awsRegion: 'ap-southeast-1',
    costCacheParamName: 'test-cost-cache-param',
    assessmentBucketName: 'test-assessment-bucket',
    ec2StateManagerServiceTokenParamName: 'test-token-param',
    ec2StateManagerFunctionUrl: 'https://example.invalid',
    actionExecutionFunctionName: 'test-action-execution-fn',
  },
  corsHeaders: () => ({}),
}));

const s3SendMock = vi.fn();
const getCommandConstructorMock = vi.fn();
const putCommandConstructorMock = vi.fn();

// Mock @aws-sdk/client-s3: tag each command with __type so s3SendMock's mockImplementation can
// distinguish Get/Put without comparing real AWS SDK instances.
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: s3SendMock })),
  GetBucketLifecycleConfigurationCommand: vi.fn().mockImplementation((input: unknown) => {
    getCommandConstructorMock(input);
    return { __type: 'Get', input };
  }),
  PutBucketLifecycleConfigurationCommand: vi.fn().mockImplementation((input: unknown) => {
    putCommandConstructorMock(input);
    return { __type: 'Put', input };
  }),
}));

const { executeApplyS3LifecyclePolicy } = await import('./s3-lifecycle-action-service.js');

const BUCKET_NAME = 'my-test-bucket';
const VALID_DAYS = 30;
const VALID_STORAGE_CLASS = 'GLACIER';

beforeEach(() => {
  s3SendMock.mockReset();
  getCommandConstructorMock.mockReset();
  putCommandConstructorMock.mockReset();
});

/** Configures s3SendMock: Get resolves/throws according to `getBehavior`, Put always resolves
 * successfully (unless a test case overrides it). */
function setupGetBehavior(
  getBehavior:
    | { type: 'resolve'; rulesCount: number; omitRulesKey?: boolean }
    | { type: 'reject'; errorName: string },
) {
  s3SendMock.mockImplementation(async (command: { __type?: string }) => {
    if (command.__type === 'Get') {
      if (getBehavior.type === 'reject') {
        throw Object.assign(new Error(getBehavior.errorName), { name: getBehavior.errorName });
      }
      if (getBehavior.omitRulesKey) {
        return {};
      }
      return {
        Rules: Array.from({ length: getBehavior.rulesCount }, (_, i) => ({ ID: `rule-${i}` })),
      };
    }
    if (command.__type === 'Put') {
      return {};
    }
    return {};
  });
}

describe('S3 lifecycle apply is guarded by existing-policy and error checks (Property 9)', () => {
  it('Case 1: no rules exist yet (Rules: [] or the Rules key is missing) → Put is called, outcome success', async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), async (omitRulesKey) => {
        // fast-check runs this property many times within a single `it` — beforeEach only resets
        // once before the whole `it`, so the mock must be reset again here to keep each run
        // independent.
        putCommandConstructorMock.mockClear();
        setupGetBehavior({ type: 'resolve', rulesCount: 0, omitRulesKey });

        const result = await executeApplyS3LifecyclePolicy(BUCKET_NAME, VALID_DAYS, VALID_STORAGE_CLASS);

        expect(putCommandConstructorMock).toHaveBeenCalledTimes(1);
        expect(result.outcome).toBe('success');
      }),
      { numRuns: 100 },
    );
  });

  it('Case 2: one or more rules already exist → Put is NOT called, outcome rejected', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 5 }), async (rulesCount) => {
        putCommandConstructorMock.mockClear();
        setupGetBehavior({ type: 'resolve', rulesCount });

        const result = await executeApplyS3LifecyclePolicy(BUCKET_NAME, VALID_DAYS, VALID_STORAGE_CLASS);

        expect(putCommandConstructorMock).toHaveBeenCalledTimes(0);
        expect(result.outcome).toBe('rejected');
      }),
      { numRuns: 100 },
    );
  });

  it('Case 3: NoSuchLifecycleConfiguration is treated as 0 rules → Put is called, outcome success', async () => {
    setupGetBehavior({ type: 'reject', errorName: 'NoSuchLifecycleConfiguration' });

    const result = await executeApplyS3LifecyclePolicy(BUCKET_NAME, VALID_DAYS, VALID_STORAGE_CLASS);

    expect(putCommandConstructorMock).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe('success');
  });

  it('Case 4: another AWS error (throttling, NoSuchBucket, ...) → Put is NOT called, outcome failure', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('ThrottlingException', 'NoSuchBucket', 'AccessDenied', 'InternalError'),
        async (errorName) => {
          putCommandConstructorMock.mockClear();
          setupGetBehavior({ type: 'reject', errorName });

          const result = await executeApplyS3LifecyclePolicy(BUCKET_NAME, VALID_DAYS, VALID_STORAGE_CLASS);

          expect(putCommandConstructorMock).toHaveBeenCalledTimes(0);
          expect(result.outcome).toBe('failure');
        },
      ),
      { numRuns: 100 },
    );
  });
});
