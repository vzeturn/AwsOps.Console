import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';

// Feature: resource-actions-and-aurora-ui, Property 7: Snapshot_And_Delete_EBS_Volume orchestration is conditionally correct
//
// For any combination of (a) volume attachment state at execution time (attached/unattached), (b)
// snapshot polling outcome (completes within 300s / times out / reports failed), and (c)
// delete-volume call outcome (success/failure), executeSnapshotAndDeleteEbsVolume SHALL call
// DeleteVolume if and only if the volume was unattached at execution time AND the snapshot reached
// completed within 300 seconds; SHALL never issue any snapshot-rollback/delete-snapshot call
// regardless of the delete outcome; and the resulting ActionExecutionResult.outcome SHALL be
// 'rejected' when not unattached, 'failure' when snapshot fails/times out or delete fails, and
// 'success' only when both the snapshot and the delete succeeded.
//
// Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 4.6

// ebs-action-service.ts reads `config.awsRegion` at module scope via `../config.js` (a module
// singleton that throws if a required env var is missing) — mock it before importing, following
// the same pattern as monitoring-service.property1.test.ts/alert-service.property7.test.ts.
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

const ec2SendMock = vi.fn();

// ebs-action-service.ts directly uses EC2Client + 4 commands: DescribeVolumesCommand,
// CreateSnapshotCommand, DescribeSnapshotsCommand, DeleteVolumeCommand — mock `send()` to dispatch
// on the `__type` attached to the input by each fake command constructor, following the same
// convention as monitoring-service.property1.test.ts/alert-service.property7.test.ts.
// DELIBERATELY not mocking `DeleteSnapshotCommand` — the implementation must NEVER import/call it
// (no snapshot rollback, Requirement 4.6); if the code accidentally calls a command not mocked
// here, the dispatcher below throws in the `default` branch, failing the test clearly.
vi.mock('@aws-sdk/client-ec2', () => ({
  EC2Client: vi.fn().mockImplementation(() => ({ send: ec2SendMock })),
  DescribeVolumesCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'DescribeVolumes', input })),
  CreateSnapshotCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'CreateSnapshot', input })),
  DescribeSnapshotsCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'DescribeSnapshots', input })),
  DeleteVolumeCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'DeleteVolume', input })),
}));

// Import after the mocks are declared (vi.mock is hoisted above by vitest).
const { executeSnapshotAndDeleteEbsVolume } = await import('./ebs-action-service.js');

const VOLUME_ID = 'vol-0123456789abcdef0';
const SNAPSHOT_ID = 'snap-0123456789abcdef0';

beforeEach(() => {
  ec2SendMock.mockReset();
});

afterEach(() => {
  // Safety net: if a test using fake timers throws before calling useRealTimers() itself, don't
  // let the fake-timers state leak into the next test.
  vi.useRealTimers();
});

function calledCommandTypes(): string[] {
  return ec2SendMock.mock.calls.map((call: unknown[]) => {
    const command = call[0] as { __type?: string };
    return command.__type ?? 'unknown';
  });
}

// ---- Property test (fast-check, real timers — every outcome here is decided right from the
// first poll, no need to wait/advance time) ----

interface Scenario {
  /** true = the volume is still attached at execution time (precondition not met). */
  attached: boolean;
  /** State DescribeSnapshots returns on the very first poll (only matters when unattached). */
  snapshotOutcome: 'completed' | 'error';
  /** Result of the DeleteVolume call (only matters when unattached AND the snapshot completed). */
  deleteOutcome: 'success' | 'failure';
}

const scenarioArb: fc.Arbitrary<Scenario> = fc.record({
  attached: fc.boolean(),
  snapshotOutcome: fc.constantFrom('completed', 'error'),
  deleteOutcome: fc.constantFrom('success', 'failure'),
});

function setupMocksForScenario(scenario: Scenario) {
  ec2SendMock.mockImplementation(async (command: { __type?: string }) => {
    switch (command.__type) {
      case 'DescribeVolumes':
        return {
          Volumes: [
            {
              VolumeId: VOLUME_ID,
              Attachments: scenario.attached ? [{ State: 'attached', InstanceId: 'i-parent' }] : [],
            },
          ],
        };
      case 'CreateSnapshot':
        return { SnapshotId: SNAPSHOT_ID };
      case 'DescribeSnapshots':
        return { Snapshots: [{ SnapshotId: SNAPSHOT_ID, State: scenario.snapshotOutcome }] };
      case 'DeleteVolume':
        if (scenario.deleteOutcome === 'failure') {
          throw new Error('mock DeleteVolume failure');
        }
        return {};
      default:
        throw new Error(`Unexpected EC2 command in mock: ${command.__type}`);
    }
  });
}

describe('Snapshot_And_Delete_EBS_Volume orchestration (Property 7)', () => {
  it('DeleteVolume is only called when unattached+completed; snapshot rollback never happens; outcome matches every combination', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        ec2SendMock.mockReset();
        setupMocksForScenario(scenario);

        const result = await executeSnapshotAndDeleteEbsVolume(VOLUME_ID);

        const calledTypes = calledCommandTypes();
        const deleteVolumeCalled = calledTypes.includes('DeleteVolume');

        // There is never any snapshot rollback/delete call, regardless of the delete-volume outcome.
        expect(calledTypes).not.toContain('DeleteSnapshot');

        if (scenario.attached) {
          // attached === true → the unattached precondition is not met.
          expect(result.outcome).toBe('rejected');
          expect(deleteVolumeCalled).toBe(false);
          expect(calledTypes).not.toContain('CreateSnapshot');
          return;
        }

        // From here on, scenario.attached === false (unattached).
        if (scenario.snapshotOutcome === 'error') {
          expect(result.outcome).toBe('failure');
          expect(result.createdSnapshotId).toBe(SNAPSHOT_ID);
          expect(deleteVolumeCalled).toBe(false);
          return;
        }

        // snapshotOutcome === 'completed'
        if (scenario.deleteOutcome === 'success') {
          expect(result.outcome).toBe('success');
          expect(result.createdSnapshotId).toBe(SNAPSHOT_ID);
          expect(deleteVolumeCalled).toBe(true);
        } else {
          expect(result.outcome).toBe('failure');
          expect(result.createdSnapshotId).toBe(SNAPSHOT_ID);
          expect(deleteVolumeCalled).toBe(true);
        }
      }),
      { numRuns: 100 },
    );
  });
});

// ---- Explicit case: snapshot polling times out after 300s (fake timers — advance simulated time
// instead of waiting 300 real seconds) ----

describe('Snapshot_And_Delete_EBS_Volume orchestration — timeout case', () => {
  it('does not reach "completed" within 300s → outcome failure, DeleteVolume is NOT called, createdSnapshotId is kept', async () => {
    vi.useFakeTimers();

    ec2SendMock.mockImplementation(async (command: { __type?: string }) => {
      switch (command.__type) {
        case 'DescribeVolumes':
          return { Volumes: [{ VolumeId: VOLUME_ID, Attachments: [] }] };
        case 'CreateSnapshot':
          return { SnapshotId: SNAPSHOT_ID };
        case 'DescribeSnapshots':
          // Always 'pending' — never completes/errors, forcing the poll loop to run to the deadline.
          return { Snapshots: [{ SnapshotId: SNAPSHOT_ID, State: 'pending' }] };
        default:
          throw new Error(`Unexpected EC2 command in mock: ${command.__type}`);
      }
    });

    const resultPromise = executeSnapshotAndDeleteEbsVolume(VOLUME_ID);

    // Advance the fake clock (including Date.now(), by default with vi.useFakeTimers()) past the
    // 300_000ms deadline — advanceTimersByTimeAsync automatically flushes microtasks between timer
    // firings, letting the poll loop (a setTimeout repeated inside an async function) run through
    // all of its iterations in a single advance call, without waiting 300 real seconds.
    await vi.advanceTimersByTimeAsync(305_000);

    const result = await resultPromise;

    expect(result.outcome).toBe('failure');
    expect(result.createdSnapshotId).toBe(SNAPSHOT_ID);
    expect(result.reason).toMatch(/300 seconds/);

    const calledTypes = calledCommandTypes();
    expect(calledTypes).not.toContain('DeleteVolume');
    expect(calledTypes).not.toContain('DeleteSnapshot');

    vi.useRealTimers();
  });
});
