import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';

// Feature: resource-actions-and-aurora-ui, Property 8: S3 lifecycle policy request is valid for the entire allowed input range
//
// For any integer days in [1, 3650] and any storage class drawn from the allowed set
// (Standard-IA, Glacier, Glacier Deep Archive), the lifecycle configuration object built by the S3
// lifecycle action service SHALL contain exactly one enabled rule whose transition Days equals
// days and whose StorageClass equals the given storage class, for every value in the input range.
//
// Validates: Requirements 5.1, 5.2

// s3-lifecycle-action-service.ts creates an S3Client at module scope, reading `config.awsRegion` —
// mock config.js following the same pattern as alert-service.property7.test.ts before importing
// the service.
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

// Mock @aws-sdk/client-s3 following the usual convention: each command constructor attaches
// `{ __type, input }` so the `send()` mock can distinguish Get vs Put, and the test can retrieve
// the `input` passed into Put.
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: s3SendMock })),
  GetBucketLifecycleConfigurationCommand: vi
    .fn()
    .mockImplementation((input: unknown) => ({ __type: 'Get', input })),
  PutBucketLifecycleConfigurationCommand: vi
    .fn()
    .mockImplementation((input: unknown) => ({ __type: 'Put', input })),
}));

const { executeApplyS3LifecyclePolicy, ALLOWED_STORAGE_CLASSES } = await import('./s3-lifecycle-action-service.js');

beforeEach(() => {
  s3SendMock.mockReset();
});

interface LifecycleRuleInput {
  ID?: string;
  Status?: string;
  Filter?: unknown;
  Transitions?: { Days?: number; StorageClass?: string }[];
}

interface PutInput {
  Bucket?: string;
  LifecycleConfiguration?: { Rules?: LifecycleRuleInput[] };
}

/**
 * Sets up the mock: Get always reports "no lifecycle policy yet" (throws
 * NoSuchLifecycleConfiguration — the correct way AWS S3 reports this state, matching the `.name`
 * check in the service). Put always resolves successfully and returns the received input, for the
 * test to capture.
 */
function setupS3Mock() {
  s3SendMock.mockImplementation(async (command: { __type?: string }) => {
    if (command.__type === 'Get') {
      const err = new Error('The lifecycle configuration does not exist') as Error & { name: string };
      err.name = 'NoSuchLifecycleConfiguration';
      throw err;
    }
    if (command.__type === 'Put') {
      return {};
    }
    return {};
  });
}

const daysArb = fc.integer({ min: 1, max: 3650 });
const storageClassArb = fc.constantFrom(...ALLOWED_STORAGE_CLASSES);

describe('S3 lifecycle policy request validity across the entire allowed input range (Property 8)', () => {
  it('for every days value in [1, 3650] and every valid storage class, the lifecycle configuration is built with exactly 1 enabled rule matching days/storageClass', async () => {
    await fc.assert(
      fc.asyncProperty(daysArb, storageClassArb, async (days, storageClass) => {
        // fast-check runs this property many times within a single `it` — beforeEach only resets
        // once before the whole `it`, so the mock must be reset again here to keep mock.calls
        // independent per run (following the pattern noted in
        // s3-lifecycle-action-service.property9.test.ts).
        s3SendMock.mockReset();
        setupS3Mock();

        const bucketName = 'test-bucket';
        const result = await executeApplyS3LifecyclePolicy(bucketName, days, storageClass);

        expect(result.outcome).toBe('success');

        const putCalls = s3SendMock.mock.calls.filter(
          (call: unknown[]) => (call[0] as { __type?: string }).__type === 'Put',
        );
        expect(putCalls).toHaveLength(1);

        const putInput = (putCalls[0][0] as { input: PutInput }).input;
        const rules = putInput.LifecycleConfiguration?.Rules ?? [];
        expect(rules).toHaveLength(1);

        const rule = rules[0];
        expect(rule.Status).toBe('Enabled');

        const transitions = rule.Transitions ?? [];
        expect(transitions).toHaveLength(1);
        expect(transitions[0].Days).toBe(days);
        expect(transitions[0].StorageClass).toBe(storageClass);
      }),
      { numRuns: 100 },
    );
  });
});
