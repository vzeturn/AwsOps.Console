import {
  DescribeVolumesCommand,
  CreateSnapshotCommand,
  DescribeSnapshotsCommand,
  DeleteVolumeCommand,
} from '@aws-sdk/client-ec2';
import type { ActionExecutionResult } from '@ops-dashboard/shared';
import { getEc2Client } from '../../core/aws-clients.js';

const ec2 = getEc2Client();

/** Total max time (ms) to wait for a snapshot to reach the 'completed' state (Requirement 4.2). */
const SNAPSHOT_POLL_TIMEOUT_MS = 300_000;

/** Interval (ms) between two `DescribeSnapshots` polls. */
const SNAPSHOT_POLL_INTERVAL_MS = 5_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Checks whether a volume is currently unattached, AT CALL TIME — used to re-check the
 * precondition right before execution (Requirement 4.5), as opposed to the static data in the
 * `Assessment_Report`/`Confirmation_Dialog` preview, which may be stale.
 */
async function isVolumeUnattached(volumeId: string): Promise<boolean> {
  const { Volumes = [] } = await ec2.send(new DescribeVolumesCommand({ VolumeIds: [volumeId] }));
  const volume = Volumes[0];
  if (!volume) return false;
  return (volume.Attachments?.length ?? 0) === 0;
}

/**
 * Polls `DescribeSnapshots` until `State` reaches `'completed'`, reports an error (`'error'`), or
 * the `SNAPSHOT_POLL_TIMEOUT_MS` wait time elapses (Requirement 4.2) — uses `Date.now()` to
 * enforce a hard cap on total elapsed time, rather than just counting a fixed number of
 * iterations (the interval between polls can drift due to API call latency).
 */
async function waitForSnapshotCompleted(snapshotId: string): Promise<'completed' | 'timeout' | 'error'> {
  const deadline = Date.now() + SNAPSHOT_POLL_TIMEOUT_MS;

  while (true) {
    const { Snapshots = [] } = await ec2.send(new DescribeSnapshotsCommand({ SnapshotIds: [snapshotId] }));
    const state = Snapshots[0]?.State;

    if (state === 'completed') return 'completed';
    if (state === 'error') return 'error';

    if (Date.now() >= deadline) return 'timeout';

    await sleep(SNAPSHOT_POLL_INTERVAL_MS);

    if (Date.now() >= deadline) return 'timeout';
  }
}

/**
 * Executes the `Snapshot_And_Delete_EBS_Volume` Resource_Action (Requirement 4.1-4.6, Property 7):
 * 1. Re-checks that the volume is still unattached at execution time — if not, `'rejected'`
 *    immediately, without throwing (this is a normal business case, not a system error).
 * 2. `CreateSnapshot` — if it throws, `'failure'` (no snapshot was created).
 * 3. Polls `DescribeSnapshots` for up to 300s. On timeout/error, `'failure'` with
 *    `createdSnapshotId`, does NOT call `DeleteVolume`, does NOT roll back/delete the snapshot.
 * 4. `DeleteVolume` — success -> `'success'` with `createdSnapshotId`; failure -> `'failure'` with
 *    `createdSnapshotId`, does NOT roll back/delete the snapshot already created (Requirement 4.6).
 */
export async function executeSnapshotAndDeleteEbsVolume(volumeId: string): Promise<ActionExecutionResult> {
  let unattached: boolean;
  try {
    unattached = await isVolumeUnattached(volumeId);
  } catch (err) {
    return {
      outcome: 'failure',
      reason: `Failed to check the attachment state of volume ${volumeId}: ${(err as Error).message}`,
    };
  }

  if (!unattached) {
    return {
      outcome: 'rejected',
      reason: `Volume ${volumeId} is no longer unattached at execution time.`,
    };
  }

  let snapshotId: string;
  try {
    const { SnapshotId } = await ec2.send(new CreateSnapshotCommand({ VolumeId: volumeId }));
    if (!SnapshotId) {
      return { outcome: 'failure', reason: `CreateSnapshot for volume ${volumeId} did not return a SnapshotId.` };
    }
    snapshotId = SnapshotId;
  } catch (err) {
    return {
      outcome: 'failure',
      reason: `Creating a snapshot for volume ${volumeId} failed: ${(err as Error).message}`,
    };
  }

  let pollResult: 'completed' | 'timeout' | 'error';
  try {
    pollResult = await waitForSnapshotCompleted(snapshotId);
  } catch (err) {
    return {
      outcome: 'failure',
      reason: `Tracking progress for snapshot ${snapshotId} failed: ${(err as Error).message}`,
      createdSnapshotId: snapshotId,
    };
  }

  if (pollResult === 'timeout') {
    return {
      outcome: 'failure',
      reason: `Snapshot ${snapshotId} did not reach "completed" within 300 seconds.`,
      createdSnapshotId: snapshotId,
    };
  }
  if (pollResult === 'error') {
    return {
      outcome: 'failure',
      reason: `Snapshot ${snapshotId} transitioned to an error state.`,
      createdSnapshotId: snapshotId,
    };
  }

  try {
    await ec2.send(new DeleteVolumeCommand({ VolumeId: volumeId }));
  } catch (err) {
    return {
      outcome: 'failure',
      reason: `Snapshot ${snapshotId} was created successfully, but deleting volume ${volumeId} failed: ${(err as Error).message}`,
      createdSnapshotId: snapshotId,
    };
  }

  return { outcome: 'success', createdSnapshotId: snapshotId };
}
