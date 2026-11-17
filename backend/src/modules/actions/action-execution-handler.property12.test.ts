import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';
import type { ActionExecutionRequest, ActionExecutionResult } from '@ops-dashboard/shared';

// Feature: resource-actions-and-aurora-ui, Property 12: Audit write failure never blocks or alters the execution result
//
// For any ActionExecutionResult (any outcome) and any audit-write failure (the audit write always
// throws), the value returned to the caller of the action-execution flow SHALL be identical to the
// ActionExecutionResult that would have been returned had the audit write succeeded — the failure
// SHALL be caught and logged, never propagated, and never change outcome/reason/other result fields.
//
// Validates: Requirements 6.4

// action-execution-handler.ts calls 4 dependency functions: 3 dispatch functions
// (executeSnapshotAndDeleteEbsVolume, executeApplyS3LifecyclePolicy, callEc2StateManager) and
// writeAuditRecord. Mock all 4 using the exact relative import path that action-execution-handler.ts
// uses — vi.mock is hoisted above the real import, so the factories below must reference closures
// (`*Mock`) declared BEFORE them with `vi.fn()` (safe to hoist since `vi.fn()` doesn't depend on any
// other variable).
const executeSnapshotAndDeleteEbsVolumeMock = vi.fn();
const executeApplyS3LifecyclePolicyMock = vi.fn();
const callEc2StateManagerMock = vi.fn();
const writeAuditRecordMock = vi.fn();
// executeEcsScaleOut/executeRdsIncreaseStorage are out of scope for this property (Property 12
// only checks the 3 original actionTypes — see testCaseArb below), but action-execution-handler.ts
// imports these 2 services at module scope, and both import config.ts (which throws if env vars are
// missing) — mock them the same way as the other 3 services so the import chain resolves without
// needing to set every required env var.
const executeEcsScaleOutMock = vi.fn();
const executeRdsIncreaseStorageMock = vi.fn();
// executeEbsModifyVolumeType/executeCloudWatchLogRetention/executeElasticIpRelease/
// executeEc2Rightsize are also out of scope for this property but need to be mocked for the same
// reason (module-scope import chain via config.ts — each of these services creates a
// `new EC2Client/RDSClient(...)` at module scope and reads `config.awsRegion` from config.ts, which
// throws if a required env var is missing).
const executeEbsModifyVolumeTypeMock = vi.fn();
const executeCloudWatchLogRetentionMock = vi.fn();
const executeElasticIpReleaseMock = vi.fn();
const executeEc2RightsizeMock = vi.fn();
// executeBackupVaultApplyProtectionPolicy/executeBackupRestoreTestingCreatePlan/executeBackupRetryJob
// are also out of scope for this property, mocked for the same reason (module-scope import chain via
// config.ts).
const executeBackupVaultApplyProtectionPolicyMock = vi.fn();
const executeBackupRestoreTestingCreatePlanMock = vi.fn();
const executeBackupRetryJobMock = vi.fn();
// executeRdsApplyResourceGovernance is also out of scope for this property, mocked for the same
// reason (module-scope import chain via config.ts).
const executeRdsApplyResourceGovernanceMock = vi.fn();
// executeEc2Reboot is out of scope for this property, mocked for the same reason (module-scope
// import chain via config.ts — creates an EC2Client at module scope, throws if a required env var is
// missing).
const executeEc2RebootMock = vi.fn();
// executeRdsStart/executeRdsStop/executeRdsReboot are also out of scope for this property, mocked
// for the same reason (module-scope import chain via config.ts).
const executeRdsStartMock = vi.fn();
const executeRdsStopMock = vi.fn();
const executeRdsRebootMock = vi.fn();
// executeSecurityGroupIngress is also out of scope for this property, mocked for the same reason
// (module-scope import chain via config.ts).
const executeSecurityGroupIngressMock = vi.fn();
// runSsmPreset is also out of scope for this property, mocked for the same reason (module-scope
// import chain via config.ts — creates an SSMClient at module scope, throws if a required env var is
// missing).
const runSsmPresetMock = vi.fn();
// executeEc2ChangeInstanceType is also out of scope for this property, mocked for the same reason
// (module-scope import chain via config.ts — creates an EC2Client at module scope, throws if a
// required env var is missing).
const executeEc2ChangeInstanceTypeMock = vi.fn();
// executeEc2UpdateTags (Task 4) is also out of scope for this property, mocked for the same reason
// (module-scope import chain via config.ts — creates an EC2Client at module scope, throws if a
// required env var is missing).
const executeEc2UpdateTagsMock = vi.fn();
// executeSecurityGroupEgress/executeEc2ModifySecurityGroups/executeSecurityGroupCreate/
// executeSecurityGroupDelete (Task 5) are also out of scope for this property, mocked for the same
// reason (module-scope import chain via config.ts).
const executeSecurityGroupEgressMock = vi.fn();
const executeEc2ModifySecurityGroupsMock = vi.fn();
const executeSecurityGroupCreateMock = vi.fn();
const executeSecurityGroupDeleteMock = vi.fn();

vi.mock('./ebs-action-service.js', () => ({
  executeSnapshotAndDeleteEbsVolume: executeSnapshotAndDeleteEbsVolumeMock,
}));
vi.mock('./s3-lifecycle-action-service.js', () => ({
  executeApplyS3LifecyclePolicy: executeApplyS3LifecyclePolicyMock,
}));
vi.mock('./ec2-state-manager-client.js', () => ({
  callEc2StateManager: callEc2StateManagerMock,
}));
vi.mock('./action-audit-service.js', () => ({
  writeAuditRecord: writeAuditRecordMock,
}));
vi.mock('./ecs-scale-action-service.js', () => ({
  executeEcsScaleOut: executeEcsScaleOutMock,
}));
vi.mock('./rds-storage-action-service.js', () => ({
  executeRdsIncreaseStorage: executeRdsIncreaseStorageMock,
}));
vi.mock('./ebs-modify-volume-type-action-service.js', () => ({
  executeEbsModifyVolumeType: executeEbsModifyVolumeTypeMock,
}));
vi.mock('./cloudwatch-log-retention-action-service.js', () => ({
  executeCloudWatchLogRetention: executeCloudWatchLogRetentionMock,
}));
vi.mock('./elastic-ip-release-action-service.js', () => ({
  executeElasticIpRelease: executeElasticIpReleaseMock,
}));
vi.mock('./ec2-rightsize-action-service.js', () => ({
  executeEc2Rightsize: executeEc2RightsizeMock,
}));
vi.mock('./backup-vault-protection-action-service.js', () => ({
  executeBackupVaultApplyProtectionPolicy: executeBackupVaultApplyProtectionPolicyMock,
}));
vi.mock('./backup-restore-testing-action-service.js', () => ({
  executeBackupRestoreTestingCreatePlan: executeBackupRestoreTestingCreatePlanMock,
}));
vi.mock('./backup-retry-job-action-service.js', () => ({
  executeBackupRetryJob: executeBackupRetryJobMock,
}));
vi.mock('./rds-resource-governance-action-service.js', () => ({
  executeRdsApplyResourceGovernance: executeRdsApplyResourceGovernanceMock,
}));
vi.mock('./ec2-reboot-action-service.js', () => ({
  executeEc2Reboot: executeEc2RebootMock,
}));
vi.mock('./rds-lifecycle-action-service.js', () => ({
  executeRdsStart: executeRdsStartMock,
  executeRdsStop: executeRdsStopMock,
  executeRdsReboot: executeRdsRebootMock,
}));
// action-execution-handler.ts imports these 4 Security Group execution functions from
// `../security/index.js` (Requirement 6.4 barrel convention) and `runSsmPreset` from
// `../ec2-management/index.js` — mock the barrels themselves (not the individual files) so the
// mock actually intercepts what action-execution-handler.ts imports; mocking the old direct file
// paths would silently miss the barrel import, causing the REAL `security/index.ts` to load
// (which pulls in `actions-security-group.ts` -> `config.ts` at module scope and throws).
vi.mock('../security/index.js', () => ({
  executeSecurityGroupIngress: executeSecurityGroupIngressMock,
  executeSecurityGroupEgress: executeSecurityGroupEgressMock,
  executeSecurityGroupCreate: executeSecurityGroupCreateMock,
  executeSecurityGroupDelete: executeSecurityGroupDeleteMock,
}));
vi.mock('../ec2-management/index.js', () => ({
  runSsmPreset: runSsmPresetMock,
}));
vi.mock('./ec2-instance-type-change-service.js', () => ({
  executeEc2ChangeInstanceType: executeEc2ChangeInstanceTypeMock,
}));
vi.mock('./ec2-tags-action-service.js', () => ({
  executeEc2UpdateTags: executeEc2UpdateTagsMock,
}));
vi.mock('./ec2-modify-security-groups-service.js', () => ({
  executeEc2ModifySecurityGroups: executeEc2ModifySecurityGroupsMock,
}));

// Import after the mocks are declared (vi.mock is hoisted above by vitest).
const { handler } = await import('./action-execution-handler.js');

beforeEach(() => {
  executeSnapshotAndDeleteEbsVolumeMock.mockReset();
  executeApplyS3LifecyclePolicyMock.mockReset();
  callEc2StateManagerMock.mockReset();
  writeAuditRecordMock.mockReset();
});

// ---- Arbitraries ----

const nonEmptyStringArb = fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0);
const outcomeArb = fc.constantFrom<'success' | 'failure' | 'rejected'>('success', 'failure', 'rejected');
const optionalStringArb = fc.option(nonEmptyStringArb, { nil: undefined });

/** Arbitrary result for Snapshot_And_Delete_EBS_Volume — includes createdSnapshotId (Requirement 4.7). */
const snapshotResultArb: fc.Arbitrary<ActionExecutionResult> = fc.record({
  outcome: outcomeArb,
  reason: optionalStringArb,
  createdSnapshotId: optionalStringArb,
});

/** Arbitrary result for Apply_S3_Lifecycle_Policy — only outcome/reason (no snapshot/newState). */
const genericResultArb: fc.Arbitrary<ActionExecutionResult> = fc.record({
  outcome: outcomeArb,
  reason: optionalStringArb,
});

const STORAGE_CLASSES = ['STANDARD_IA', 'GLACIER', 'DEEP_ARCHIVE'] as const;

/** Arbitrary result returned from callEc2StateManager (the StateManager contract). */
const ec2CallResultArb = fc.oneof(
  fc.record({ success: fc.constant(true as const), state: nonEmptyStringArb }),
  fc.record({ success: fc.constant(false as const), error: nonEmptyStringArb }),
);

interface TestCase {
  event: ActionExecutionRequest;
  expectedResult: ActionExecutionResult;
  setupMocks: () => void;
}

/**
 * Generates one arbitrary test case for EACH actionType in Action_Catalog: a valid event + a mock
 * of the matching dispatch function resolving with an arbitrary ActionExecutionResult
 * (Snapshot_And_Delete_EBS_Volume, Apply_S3_Lifecycle_Policy) or an arbitrary
 * CallEc2StateManagerResult (EC2_Start/EC2_Stop, from which the expected ActionExecutionResult is
 * then derived exactly the way action-execution-handler.ts maps that result).
 */
const testCaseArb: fc.Arbitrary<TestCase> = fc.oneof(
  fc
    .record({
      resourceId: nonEmptyStringArb,
      region: nonEmptyStringArb,
      executedBy: nonEmptyStringArb,
      result: snapshotResultArb,
    })
    .map(({ resourceId, region, executedBy, result }): TestCase => ({
      event: {
        actionType: 'Snapshot_And_Delete_EBS_Volume',
        resourceId,
        region,
        params: {},
        executedBy,
      },
      expectedResult: result,
      setupMocks: () => {
        executeSnapshotAndDeleteEbsVolumeMock.mockResolvedValue(result);
      },
    })),

  fc
    .record({
      resourceId: nonEmptyStringArb,
      region: nonEmptyStringArb,
      executedBy: nonEmptyStringArb,
      days: fc.integer({ min: 1, max: 3650 }),
      storageClass: fc.constantFrom(...STORAGE_CLASSES),
      result: genericResultArb,
    })
    .map(({ resourceId, region, executedBy, days, storageClass, result }): TestCase => ({
      // days/storageClass are valid by TYPE (number/string) — enough for
      // action-execution-handler.ts's dispatch() to go through the branch calling
      // executeApplyS3LifecyclePolicy instead of the early-return "Invalid params" (the handler only
      // checks typeof, not range/enum — that's the service's job).
      event: {
        actionType: 'Apply_S3_Lifecycle_Policy',
        resourceId,
        region,
        params: { days, storageClass },
        executedBy,
      },
      expectedResult: result,
      setupMocks: () => {
        executeApplyS3LifecyclePolicyMock.mockResolvedValue(result);
      },
    })),

  fc
    .record({
      actionType: fc.constantFrom<'EC2_Start' | 'EC2_Stop'>('EC2_Start', 'EC2_Stop'),
      resourceId: nonEmptyStringArb,
      region: nonEmptyStringArb,
      executedBy: nonEmptyStringArb,
      callResult: ec2CallResultArb,
    })
    .map(({ actionType, resourceId, region, executedBy, callResult }): TestCase => {
      // Mapping EXACTLY as in action-execution-handler.ts: success → {outcome:'success', newState:
      // result.state}; !success → {outcome:'failure', reason: result.error}.
      const expectedResult: ActionExecutionResult = callResult.success
        ? { outcome: 'success', newState: callResult.state }
        : { outcome: 'failure', reason: callResult.error };

      return {
        event: {
          actionType,
          resourceId,
          region,
          params: {},
          executedBy,
        },
        expectedResult,
        setupMocks: () => {
          callEc2StateManagerMock.mockResolvedValue(callResult);
        },
      };
    }),
);

describe('Audit write failure never blocks or alters the execution result (Property 12)', () => {
  it('handler returns EXACTLY the dispatch result, never throws, and still calls writeAuditRecord — even when writeAuditRecord ALWAYS throws', async () => {
    await fc.assert(
      fc.asyncProperty(testCaseArb, async ({ event, expectedResult, setupMocks }) => {
        executeSnapshotAndDeleteEbsVolumeMock.mockReset();
        executeApplyS3LifecyclePolicyMock.mockReset();
        callEc2StateManagerMock.mockReset();
        writeAuditRecordMock.mockReset();
        // Property premise: the audit write ALWAYS throws, on EVERY test run.
        writeAuditRecordMock.mockRejectedValue(new Error('audit write always fails'));

        setupMocks();

        // If handler() propagates the error from writeAuditRecord, the await here would reject and
        // fail this property — this is exactly how "doesn't throw/doesn't propagate" is asserted
        // (item 6 of the task).
        const result = await handler(event);

        // The returned result is EXACTLY the result the dispatch function returned — the audit
        // write failure has no effect whatsoever on outcome/reason/createdSnapshotId/newState.
        expect(result).toEqual(expectedResult);

        // writeAuditRecord is still called (exactly once) — ITS error is swallowed, but the call
        // itself is not skipped.
        expect(writeAuditRecordMock).toHaveBeenCalledTimes(1);
      }),
      { numRuns: 100 },
    );
  });
});

// ---- Explicit case: no unhandled rejection leaks out even when writeAuditRecord always rejects ----

describe('Audit write failure — no unhandled rejection leaks', () => {
  it('calls handler() repeatedly with writeAuditRecord always rejecting, and no unhandledRejection is ever emitted', async () => {
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      executeSnapshotAndDeleteEbsVolumeMock.mockResolvedValue({ outcome: 'success' } satisfies ActionExecutionResult);
      writeAuditRecordMock.mockRejectedValue(new Error('audit write always fails'));

      const event: ActionExecutionRequest = {
        actionType: 'Snapshot_And_Delete_EBS_Volume',
        resourceId: 'vol-0123456789abcdef0',
        region: 'ap-southeast-1',
        params: {},
        executedBy: 'user@example.com',
      };

      for (let i = 0; i < 10; i++) {
        const result = await handler(event);
        expect(result).toEqual({ outcome: 'success' });
      }

      // Flush the microtask queue so any promise rejection (already swallowed by .catch() inside
      // the handler) has a chance to be reported by Node as "unhandled" IF it truly wasn't caught —
      // if the implementation is correct, this list must always be empty.
      await new Promise((resolve) => setImmediate(resolve));

      expect(unhandledRejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });
});
