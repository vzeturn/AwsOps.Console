import { DescribeInstancesCommand, ModifyInstanceAttributeCommand } from '@aws-sdk/client-ec2';
import type { ActionExecutionResult } from '@ops-dashboard/shared';
import { getEc2Client } from '../../core/aws-clients.js';
import { logger } from '../../shared-kernel/logger.js';

const ec2 = getEc2Client();

/**
 * Executes `Ec2_ChangeInstanceType` — changes instance type via ec2:ModifyInstanceAttribute. AWS
 * REQUIRES the instance to be in 'stopped' state to change to a different family (cross-family) —
 * re-checks the REAL state at execution time (does not trust preview data), same as every other
 * mutating service in this repo.
 */
export async function executeEc2ChangeInstanceType(
  instanceId: string,
  params: Record<string, string | number>,
): Promise<ActionExecutionResult> {
  const targetInstanceType = params.targetInstanceType;
  if (typeof targetInstanceType !== 'string' || targetInstanceType.length === 0) {
    return { outcome: 'failure', reason: 'Missing or invalid: targetInstanceType' };
  }

  let currentState: string;
  try {
    const { Reservations = [] } = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
    const instance = Reservations[0]?.Instances?.[0];
    if (!instance) {
      return { outcome: 'failure', reason: `EC2 instance ${instanceId} not found` };
    }
    currentState = instance.State?.Name ?? 'unknown';
  } catch (err) {
    logger.error(`ec2-instance-type-change-service: DescribeInstances(${instanceId}) failed`, err);
    return { outcome: 'failure', reason: 'Unable to verify EC2 instance state' };
  }

  if (currentState !== 'stopped') {
    return {
      outcome: 'rejected',
      reason: `Instance ${instanceId} is currently in "${currentState}" state — the instance type can only be changed while it is "stopped".`,
    };
  }

  try {
    await ec2.send(
      new ModifyInstanceAttributeCommand({
        InstanceId: instanceId,
        InstanceType: { Value: targetInstanceType },
      }),
    );
  } catch (err) {
    logger.error(`ec2-instance-type-change-service: ModifyInstanceAttribute(${instanceId}) failed`, err);
    const message = err instanceof Error ? err.message : 'unknown error';
    return { outcome: 'failure', reason: `ModifyInstanceAttribute failed: ${message}` };
  }

  return { outcome: 'success', newInstanceType: targetInstanceType };
}
