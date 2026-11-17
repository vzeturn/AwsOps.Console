import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';
import type { ActionOutcome, ActionType } from '@ops-dashboard/shared';

// Feature: resource-actions-and-aurora-ui, Property 11: Audit trail retrieval is an exact, resource-scoped, time-descending filter
//
// For any set of stored ActionAuditRecords across arbitrary resources and any queried
// (resourceType, resourceId), listAuditRecordsForResource SHALL return exactly the subset of
// records whose resource identity matches the query (no records fabricated or omitted), sorted by
// executedAt in strictly non-increasing order.
//
// Validates: Requirements 6.3, 10.5

// action-audit-service.ts statically imports `config` from '../../config.js' (throws at module scope
// if a required env var is missing via readRequiredEnv) — mock config.js following the same
// pattern as monitoring-service.property1.test.ts/alert-service.property7.test.ts so the import
// doesn't throw.
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
    ec2StateManagerFunctionUrl: 'https://example.invalid',
    actionExecutionFunctionName: 'test-action-execution-fn',
  },
  corsHeaders: () => ({}),
}));

const s3SendMock = vi.fn();

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: s3SendMock })),
  PutObjectCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'PutObject', input })),
  ListObjectsV2Command: vi.fn().mockImplementation((input: unknown) => ({ __type: 'ListObjectsV2', input })),
  GetObjectCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'GetObject', input })),
}));

// Import after the mocks are declared (vi.mock is hoisted above by vitest).
const { listAuditRecordsForResource } = await import('./action-audit-service.js');

beforeEach(() => {
  s3SendMock.mockReset();
});

// ---- Arbitraries ----

/**
 * Small, fixed pool of (resourceType, resourceId) pairs — DELIBERATELY has 2 pool entries sharing
 * the same resourceType ('ec2-instance') to force disambiguation by resourceId, not just
 * resourceType. Each entry's `actionTypes` are chosen to match EXACTLY that entry's resourceType
 * per the real ACTION_CATALOG (see shared/src/index.ts) — meaning
 * `resolveResourceTypeForKey(actionType)` (the actionType-to-resourceType derivation logic in
 * action-audit-service.ts) always produces the correct resourceType for the corresponding pool
 * entry, exactly like the real implementation derives resourceType for the S3 key.
 */
const RESOURCE_POOL = [
  { resourceType: 'ec2-instance', resourceId: 'i-aaa', actionTypes: ['EC2_Start', 'EC2_Stop'] as ActionType[] },
  { resourceType: 'ec2-instance', resourceId: 'i-bbb', actionTypes: ['EC2_Start', 'EC2_Stop'] as ActionType[] },
  { resourceType: 'ebs-volume', resourceId: 'vol-ccc', actionTypes: ['Snapshot_And_Delete_EBS_Volume'] as ActionType[] },
] as const;

function objectKeyPrefix(resourceType: string, resourceId: string): string {
  return `action-audit/${resourceType}-${resourceId}/`;
}

/** poolIndex + a valid actionType (matching resourceType) for that pool entry — a dependent arbitrary using fc.oneof. */
const poolEntryWithActionArb = fc.oneof(
  ...RESOURCE_POOL.map((entry, poolIndex) =>
    fc.constantFrom(...entry.actionTypes).map((actionType) => ({ poolIndex, actionType })),
  ),
);

const OUTCOMES: ActionOutcome[] = ['success', 'failure', 'rejected'];

const recordSpecArb = fc.record({
  poolEntryWithAction: poolEntryWithActionArb,
  executedBy: fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0),
  // ISO string directly from fc.date() — keeps every timestamp in the same format/timezone (UTC,
  // 'Z' suffix) so lexicographic string comparison is equivalent to real time comparison (matching
  // how the real implementation sorts — action-audit-service.ts compares executedAt via plain
  // string comparison).
  executedAt: fc
    .date({ min: new Date('2020-01-01T00:00:00.000Z'), max: new Date('2030-01-01T00:00:00.000Z'), noInvalidDate: true })
    .map((d) => d.toISOString()),
  outcome: fc.constantFrom(...OUTCOMES),
  reason: fc.option(fc.string({ minLength: 1, maxLength: 30 }), { nil: undefined }),
  region: fc.string({ minLength: 1, maxLength: 10 }).filter((s) => s.trim().length > 0),
  arn: fc.string({ minLength: 1, maxLength: 30 }).filter((s) => s.trim().length > 0),
});

interface RecordSpec {
  poolEntryWithAction: { poolIndex: number; actionType: ActionType };
  executedBy: string;
  executedAt: string;
  outcome: ActionOutcome;
  reason: string | undefined;
  region: string;
  arn: string;
}

interface StoredEntry {
  key: string;
  poolIndex: number;
  record: {
    executedBy: string;
    executedAt: string;
    actionType: ActionType;
    resource: { id: string; arn: string; region: string };
    params: Record<string, string | number>;
    outcome: ActionOutcome;
    reason?: string;
  };
}

function buildStoredEntries(specs: RecordSpec[]): StoredEntry[] {
  return specs.map((spec, idx) => {
    const pool = RESOURCE_POOL[spec.poolEntryWithAction.poolIndex];
    const record = {
      executedBy: spec.executedBy,
      executedAt: spec.executedAt,
      actionType: spec.poolEntryWithAction.actionType,
      resource: { id: pool.resourceId, arn: spec.arn, region: spec.region },
      // __testId: a unique marker for each generated record — ONLY so the test can match input to
      // output exactly 1:1 when the other "real" fields might collide across multiple records.
      params: { __testId: idx },
      outcome: spec.outcome,
      ...(spec.reason !== undefined ? { reason: spec.reason } : {}),
    };
    // A unique suffix by idx ensures the S3 key never collides, even when executedAt collides
    // across multiple records (2 concurrent executions on the same resource, the same design
    // rationale for 1-object-per-record noted in design.md).
    const key = `${objectKeyPrefix(pool.resourceType, pool.resourceId)}${spec.executedAt}-${idx}.json`;
    return { key, poolIndex: spec.poolEntryWithAction.poolIndex, record };
  });
}

describe('listAuditRecordsForResource (Property 11)', () => {
  it('returns exactly the subset matching (resourceType, resourceId), sorted descending by executedAt', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(recordSpecArb, { maxLength: 30 }),
        fc.integer({ min: 0, max: RESOURCE_POOL.length - 1 }),
        async (specs, queryPoolIndex) => {
          const stored = buildStoredEntries(specs);
          const recordByKey = new Map(stored.map((entry) => [entry.key, entry.record]));
          const allKeys = stored.map((entry) => entry.key);

          s3SendMock.mockImplementation(async (command: { __type: string; input: { Prefix?: string; Key?: string } }) => {
            if (command.__type === 'ListObjectsV2') {
              const prefix = command.input.Prefix ?? '';
              const matchingKeys = allKeys.filter((key) => key.startsWith(prefix));
              return { Contents: matchingKeys.map((Key) => ({ Key })) };
            }
            if (command.__type === 'GetObject') {
              const key = command.input.Key!;
              const record = recordByKey.get(key);
              return { Body: { transformToString: async () => JSON.stringify(record) } };
            }
            throw new Error(`unexpected command ${command.__type}`);
          });

          const queryPool = RESOURCE_POOL[queryPoolIndex];
          const result = await listAuditRecordsForResource(queryPool.resourceType, queryPool.resourceId);

          // ---- Exactness: exactly the subset matching resource identity, no extra, no missing ----
          const expected = stored.filter((entry) => entry.poolIndex === queryPoolIndex);
          expect(result).toHaveLength(expected.length);

          const expectedTestIds = new Set(expected.map((entry) => entry.record.params.__testId));
          const resultTestIds = result.map((r) => (r.params as Record<string, string | number>).__testId);
          expect(new Set(resultTestIds)).toEqual(expectedTestIds);
          // No __testId repeats in the result (no record is duplicated/fabricated).
          expect(resultTestIds).toHaveLength(new Set(resultTestIds).size);

          // Every returned record matches EXACTLY (deep equal) its corresponding stored record.
          const expectedByTestId = new Map(expected.map((entry) => [entry.record.params.__testId, entry.record]));
          for (const r of result) {
            const testId = (r.params as Record<string, string | number>).__testId;
            expect(r).toEqual(expectedByTestId.get(testId));
          }

          // ---- Sorted descending (non-increasing) by executedAt ----
          for (let i = 0; i < result.length - 1; i++) {
            expect(result[i].executedAt >= result[i + 1].executedAt).toBe(true);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
