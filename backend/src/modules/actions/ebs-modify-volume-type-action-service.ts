import { DescribeVolumesCommand, ModifyVolumeCommand } from '@aws-sdk/client-ec2';
import type { ActionExecutionResult } from '@ops-dashboard/shared';
import { getEc2Client } from '../../core/aws-clients.js';

/**
 * `ebs-modify-volume-type-action-service.ts` runs inside `action-execution-fn` (a dedicated
 * mutate Lambda, `ActionExecutionRole`). Executes the `EBS_ModifyVolumeType` Resource_Action —
 * converts a volume type from gp2 to gp3 (cheaper, higher baseline performance — see findingType
 * `ebsVolumeGp2ShouldBeGp3` in `infra-review-collector.ts`). `ec2:ModifyVolume` is an ONLINE
 * operation — no detach/downtime needed, and AWS supports converting BACK from gp3 to gp2 with
 * this same API if needed, so this is a genuinely reversible action (see `ACTION_CATALOG`).
 */
const ec2 = getEc2Client();

/** Only allows converting EXACTLY gp2 -> gp3 — does not apply to any other volume type
 * (specifically, does NOT convert io1/io2/st1/sc1, which are already optimized for specific
 * performance requirements). */
const SOURCE_VOLUME_TYPE = 'gp2';
const TARGET_VOLUME_TYPE = 'gp3';

/**
 * Executes `EBS_ModifyVolumeType`: re-reads the current `VolumeType` AT EXECUTION TIME (don't
 * trust the data shown in Confirmation_Dialog, which may be stale — the same principle
 * `ebs-action-service.ts` uses to re-check right before mutating), only proceeds if the volume IS
 * CURRENTLY gp2.
 *
 * - Volume doesn't exist -> `'rejected'`.
 * - Volume is NO LONGER gp2 (it was converted to another type already, or the preview data is
 *   stale) -> `'rejected'`.
 * - `ModifyVolume` fails -> `'failure'`.
 */
export async function executeEbsModifyVolumeType(volumeId: string): Promise<ActionExecutionResult> {
  let currentVolumeType: string;
  try {
    const { Volumes = [] } = await ec2.send(new DescribeVolumesCommand({ VolumeIds: [volumeId] }));
    const volume = Volumes[0];
    if (!volume) {
      return { outcome: 'rejected', reason: `EBS volume ${volumeId} not found at execution time.` };
    }
    currentVolumeType = volume.VolumeType ?? '';
  } catch (err) {
    return { outcome: 'failure', reason: `Failed to read the current state of volume ${volumeId}: ${(err as Error).message}` };
  }

  if (currentVolumeType !== SOURCE_VOLUME_TYPE) {
    return {
      outcome: 'rejected',
      reason: `Volume ${volumeId} is currently "${currentVolumeType}", no longer gp2 at execution time.`,
    };
  }

  try {
    await ec2.send(new ModifyVolumeCommand({ VolumeId: volumeId, VolumeType: TARGET_VOLUME_TYPE }));
  } catch (err) {
    return { outcome: 'failure', reason: `ModifyVolume failed for ${volumeId}: ${(err as Error).message}` };
  }

  return { outcome: 'success', newVolumeType: TARGET_VOLUME_TYPE };
}
