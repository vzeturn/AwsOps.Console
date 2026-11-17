import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';
import { ACTION_CATALOG, type ActionAuditRecord, type ActionType } from '@ops-dashboard/shared';

// Feature: resource-actions-and-aurora-ui, Property 10: Action_Audit_Record is complete for every execution outcome
//
// For any combination of actionType (all 4 catalog values), resource identity, arbitrary parameter
// map, and outcome ('success'/'failure'/'rejected', with or without a reason), buildAuditRecord
// SHALL produce an ActionAuditRecord where all six required fields (executedBy, executedAt,
// actionType, resource identity, params, outcome) are present and non-empty, and reason is present
// whenever outcome !== 'success'.
//
// Validates: Requirements 6.1, 9.4
//
// Note on scope: the actual codebase has no standalone `buildAuditRecord` function — the
// ActionAuditRecord is inline-constructed in `action-execution-handler.ts`'s `handler()` (exercised
// by task 5.2's action-execution-handler.property12.test.ts). This file targets
// `writeAuditRecord()` in `action-audit-service.ts` itself: the property under test here is that
// `writeAuditRecord` persists an already-complete ActionAuditRecord to S3 WITHOUT dropping,
// mutating, or truncating any of the 6 required fields (or `reason`, when present) — i.e. the
// completeness produced by the caller survives the write untouched.

// action-audit-service.ts reads `config.assessmentBucketName`/`config.awsRegion` at module scope
// via `../config.js` (a module singleton that throws if a required env var is missing) — mock it
// before importing, following the same pattern as ebs-action-service.property7.test.ts.
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

// Import after the mocks/env are declared (vi.mock is hoisted above by vitest).
const { writeAuditRecord } = await import('./action-audit-service.js');

beforeEach(() => {
  s3SendMock.mockReset();
  s3SendMock.mockImplementation(async (command: { __type: string }) => {
    if (command.__type === 'PutObject') return {};
    throw new Error(`unexpected command ${command.__type}`);
  });
});

const actionTypeArb: fc.Arbitrary<ActionType> = fc.constantFrom(...ACTION_CATALOG.map((entry) => entry.actionType));

const paramsArb = fc.dictionary(
  fc.string({ minLength: 1 }).filter((s) => s.trim().length > 0),
  fc.oneof(fc.string(), fc.integer()),
);

const recordArb: fc.Arbitrary<ActionAuditRecord> = fc
  .record({
    executedBy: fc.string({ minLength: 1 }).filter((s) => s.trim().length > 0),
    executedAt: fc.date({ noInvalidDate: true }).map((d) => d.toISOString()),
    actionType: actionTypeArb,
    resource: fc.record({
      id: fc.string({ minLength: 1 }).filter((s) => s.trim().length > 0),
      arn: fc.string({ minLength: 1 }).filter((s) => s.trim().length > 0),
      region: fc.string({ minLength: 1 }).filter((s) => s.trim().length > 0),
    }),
    params: paramsArb,
    outcome: fc.constantFrom('success', 'failure', 'rejected') as fc.Arbitrary<ActionAuditRecord['outcome']>,
    reason: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
  })
  .map(({ reason, ...rest }) => (reason !== undefined ? { ...rest, reason } : rest));

describe('writeAuditRecord — round-trip fidelity of Action_Audit_Record persistence (Property 10)', () => {
  it('persists all 6 required fields (and reason, when present) to S3 without dropping/mutating/truncating any of them', async () => {
    await fc.assert(
      fc.asyncProperty(recordArb, async (record) => {
        s3SendMock.mockClear();

        await writeAuditRecord(record);

        const putCalls = s3SendMock.mock.calls.filter(([cmd]) => (cmd as { __type: string }).__type === 'PutObject');
        expect(putCalls).toHaveLength(1);

        const input = (putCalls[0][0] as { input: { Body: string } }).input;
        const persisted = JSON.parse(input.Body) as ActionAuditRecord;

        // All 6 required fields must be present and equal to their original values, unchanged.
        expect(persisted.executedBy).toBe(record.executedBy);
        expect(typeof persisted.executedBy).toBe('string');
        expect(persisted.executedBy.length).toBeGreaterThan(0);

        expect(persisted.executedAt).toBe(record.executedAt);
        expect(typeof persisted.executedAt).toBe('string');
        expect(persisted.executedAt.length).toBeGreaterThan(0);

        expect(persisted.actionType).toBe(record.actionType);
        expect(typeof persisted.actionType).toBe('string');
        expect(persisted.actionType.length).toBeGreaterThan(0);

        expect(persisted.resource).toEqual(record.resource);

        expect(persisted.params).toEqual(record.params);

        expect(persisted.outcome).toBe(record.outcome);
        expect(typeof persisted.outcome).toBe('string');
        expect(persisted.outcome.length).toBeGreaterThan(0);

        // reason: round-trips exactly — present iff it was present in the input, with the same value.
        if (record.reason !== undefined) {
          expect(persisted.reason).toBe(record.reason);
        } else {
          expect(persisted.reason).toBeUndefined();
        }
      }),
      { numRuns: 100 },
    );
  });
});
