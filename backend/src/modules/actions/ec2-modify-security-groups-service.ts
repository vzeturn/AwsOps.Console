import { DescribeInstancesCommand, ModifyInstanceAttributeCommand } from '@aws-sdk/client-ec2';
import type { ActionExecutionResult } from '@ops-dashboard/shared';
import { getEc2Client } from '../../core/aws-clients.js';
import { logger } from '../../shared-kernel/logger.js';

/**
 * Runs inside `action-execution-fn`. Executes `Ec2_ModifySecurityGroups` — replaces the entire
 * list of Security Groups attached to the instance via `ModifyInstanceAttributeCommand` (Groups).
 * AWS treats this as a full replacement, not a partial add/remove.
 */
const ec2 = getEc2Client();

export async function executeEc2ModifySecurityGroups(
  instanceId: string,
  params: Record<string, string | number>,
): Promise<ActionExecutionResult> {
  const raw = params.groupIds;
  let groupIds: unknown;
  try {
    groupIds = JSON.parse(String(raw));
  } catch {
    return { outcome: 'failure', reason: 'groupIds is not valid JSON.' };
  }

  if (!Array.isArray(groupIds) || !groupIds.every((id) => typeof id === 'string')) {
    return { outcome: 'failure', reason: 'groupIds must be a string[] array.' };
  }

  if (groupIds.length === 0) {
    // AWS itself rejects an empty list (an instance must always belong to >=1 SG) — block early to
    // avoid a wasted API call, treated as a business rejection rather than a system error.
    return { outcome: 'rejected', reason: 'The instance must belong to at least 1 Security Group.' };
  }

  // Re-reads the REAL state at execution time (does not trust preview data, which may be stale) —
  // same pattern as security-group-action-service.ts/ec2-instance-type-change-service.ts. `Groups`
  // is a full-replacement list, so ModifyInstanceAttribute must NOT be called directly from client
  // input: if the instance was terminated or no longer exists between the user opening the dialog
  // and confirming, that must be detected and rejected here instead of letting AWS return a vague
  // error or (worse) applying the map to the wrong instance.
  try {
    const { Reservations = [] } = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
    const instance = Reservations[0]?.Instances?.[0];
    if (!instance) {
      return { outcome: 'rejected', reason: `EC2 instance ${instanceId} not found at execution time.` };
    }
  } catch (err) {
    logger.error(`ec2-modify-security-groups-service: DescribeInstances(${instanceId}) failed`, err);
    return {
      outcome: 'failure',
      reason: `Unable to read the current state of instance ${instanceId}: ${(err as Error).message}`,
    };
  }

  try {
    await ec2.send(new ModifyInstanceAttributeCommand({ InstanceId: instanceId, Groups: groupIds }));
  } catch (err) {
    logger.error(`ec2-modify-security-groups-service: Ec2_ModifySecurityGroups(${instanceId}) failed`, err);
    const message = err instanceof Error ? err.message : 'unknown error';
    return { outcome: 'failure', reason: message };
  }

  return { outcome: 'success', newSecurityGroupIds: groupIds };
}
