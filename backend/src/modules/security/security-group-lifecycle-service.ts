import { CreateSecurityGroupCommand, DeleteSecurityGroupCommand, DescribeInstancesCommand } from '@aws-sdk/client-ec2';
import type { ActionExecutionResult } from '@ops-dashboard/shared';
import { getEc2Client } from '../../core/aws-clients.js';
import { logger } from '../../shared-kernel/logger.js';

/**
 * Runs inside `action-execution-fn`. Executes `SecurityGroup_Create` and `SecurityGroup_Delete`.
 */
const ec2 = getEc2Client();

export async function executeSecurityGroupCreate(params: Record<string, string | number>): Promise<ActionExecutionResult> {
  const groupName = params.groupName;
  const description = params.description;
  const vpcId = params.vpcId;
  if (typeof groupName !== 'string' || !groupName || typeof description !== 'string' || !description || typeof vpcId !== 'string' || !vpcId) {
    return { outcome: 'failure', reason: 'Missing or invalid: groupName, description, and vpcId are all required' };
  }

  try {
    const { GroupId } = await ec2.send(new CreateSecurityGroupCommand({ GroupName: groupName, Description: description, VpcId: vpcId }));
    if (!GroupId) {
      return { outcome: 'failure', reason: 'CreateSecurityGroup did not return a GroupId' };
    }
    return { outcome: 'success', createdSecurityGroupId: GroupId };
  } catch (err) {
    logger.error(`security-group-lifecycle-service: CreateSecurityGroup failed`, err);
    const message = err instanceof Error ? err.message : 'unknown error';
    return { outcome: 'failure', reason: message };
  }
}

/**
 * Blocks the delete if ANY instance still references the SG (ec2:DescribeInstances filtered by
 * instance.group-id) — a real pre-flight check, not a static warning (Section 5 spec).
 */
// Known limitation, accepted for this plan: this pre-flight check only verifies instance
// attachment (DescribeInstances filtered by instance.group-id). It does NOT check whether
// another Security Group's ingress/egress rules still reference this group as a source
// (SG-to-SG reference, not CIDR). If so, the DeleteSecurityGroupCommand call below will
// separately fail with AWS's own `DependencyViolation` error — caught by the try/catch and
// surfaced to the user as a generic action-failure reason string, not a pre-flight-caught,
// user-friendly message naming the referencing group. Out of scope to fix in this plan; would
// need an additional DescribeSecurityGroups scan across all groups in the VPC checking each
// rule's UserIdGroupPairs for this groupId.
export async function executeSecurityGroupDelete(groupId: string): Promise<ActionExecutionResult> {
  let referencingInstanceIds: string[];
  try {
    const { Reservations = [] } = await ec2.send(
      new DescribeInstancesCommand({ Filters: [{ Name: 'instance.group-id', Values: [groupId] }] }),
    );
    referencingInstanceIds = Reservations.flatMap((r) => r.Instances ?? [])
      .map((i) => i.InstanceId)
      .filter((id): id is string => !!id);
  } catch (err) {
    logger.error(`security-group-lifecycle-service: DescribeInstances(group-id=${groupId}) failed`, err);
    return { outcome: 'failure', reason: 'Unable to verify Security Group usage' };
  }

  if (referencingInstanceIds.length > 0) {
    return {
      outcome: 'rejected',
      reason: `Cannot delete Security Group ${groupId} — it is still attached to instances: ${referencingInstanceIds.join(', ')}`,
    };
  }

  try {
    await ec2.send(new DeleteSecurityGroupCommand({ GroupId: groupId }));
  } catch (err) {
    logger.error(`security-group-lifecycle-service: DeleteSecurityGroup(${groupId}) failed`, err);
    const message = err instanceof Error ? err.message : 'unknown error';
    return { outcome: 'failure', reason: message };
  }

  return { outcome: 'success' };
}
