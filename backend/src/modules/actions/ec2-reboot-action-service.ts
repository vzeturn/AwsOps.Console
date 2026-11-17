import { DescribeInstancesCommand, RebootInstancesCommand } from '@aws-sdk/client-ec2';
import type { ActionExecutionResult } from '@ops-dashboard/shared';
import { getEc2Client } from '../../core/aws-clients.js';

/**
 * Runs inside `action-execution-fn` (a dedicated mutate Lambda, role `ActionExecutionRole`).
 * Executes `EC2_Reboot` (`ec2:RebootInstances`) directly via the EC2 API — NOT through
 * `StateManager` (the external service only supports start/stop, no reboot endpoint).
 */
const ec2 = getEc2Client();

/**
 * Re-reads the current state AT EXECUTION TIME (never trusts preview data that may be stale),
 * proceeding only if the instance is STILL "running".
 */
export async function executeEc2Reboot(instanceId: string): Promise<ActionExecutionResult> {
  let currentState: string;
  try {
    const { Reservations = [] } = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
    const instance = Reservations[0]?.Instances?.[0];
    if (!instance) {
      return { outcome: 'rejected', reason: `EC2 instance ${instanceId} not found at execution time.` };
    }
    currentState = instance.State?.Name ?? 'unknown';
  } catch (err) {
    return { outcome: 'failure', reason: `Could not read the current state of EC2 instance ${instanceId}: ${(err as Error).message}` };
  }

  if (currentState !== 'running') {
    return {
      outcome: 'rejected',
      reason: `EC2 instance ${instanceId} is in state "${currentState}" at execution time — it can only be rebooted while "running".`,
    };
  }

  try {
    await ec2.send(new RebootInstancesCommand({ InstanceIds: [instanceId] }));
  } catch (err) {
    return { outcome: 'failure', reason: `RebootInstances failed for ${instanceId}: ${(err as Error).message}` };
  }

  return { outcome: 'success', newState: 'rebooting' };
}
