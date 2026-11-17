import {
  DescribeSecurityGroupsCommand,
  AuthorizeSecurityGroupIngressCommand,
  RevokeSecurityGroupIngressCommand,
} from '@aws-sdk/client-ec2';
import type { IpPermission, SecurityGroup } from '@aws-sdk/client-ec2';
import {
  parseSecurityGroupIngressRule,
  describeSecurityGroupRule,
  securityGroupHasIngressRule,
} from '@ops-dashboard/shared';
import type { ActionExecutionResult, SecurityGroupIngressRule } from '@ops-dashboard/shared';
import { getEc2Client } from '../../core/aws-clients.js';

/**
 * Runs inside `action-execution-fn` (the dedicated mutate Lambda, role `ActionExecutionRole`).
 * Executes `SecurityGroup_AuthorizeIngress` / `SecurityGroup_RevokeIngress` — ingress ONLY,
 * IPv4 CIDR sources ONLY, matching sub-project #3's scope exactly.
 */
const ec2 = getEc2Client();

type SecurityGroupActionType = 'SecurityGroup_AuthorizeIngress' | 'SecurityGroup_RevokeIngress';

/**
 * These 3 error codes are NOT system incidents but the business outcome of a race: between our
 * describe and our mutate, someone else (or another tab) changed the Security Group. The final
 * state already matches what the user wanted, or there's simply nothing left to do — so we return
 * `rejected` (business outcome) rather than `failure` (incident), so operators don't go
 * investigating an incident that isn't one.
 */
const BENIGN_AWS_ERROR_REASONS: Record<string, string> = {
  'InvalidPermission.Duplicate': 'This rule already exists on the Security Group (someone else may have just added it).',
  'InvalidPermission.NotFound': 'This rule was not found on the Security Group (someone else may have just removed it).',
  'InvalidGroup.NotFound': 'Security Group not found.',
};

/** The AWS SDK v3 exception name lives in `err.name`; `instanceof` doesn't work because these
 * error classes are generated dynamically at runtime and are mocked in tests. */
function awsErrorName(err: unknown): string {
  return err instanceof Error ? err.name : '';
}

/** The `IpPermissions` payload is shared by both Authorize and Revoke — the two APIs accept the exact same shape. */
function toIpPermission(rule: SecurityGroupIngressRule): IpPermission {
  return {
    IpProtocol: rule.protocol,
    FromPort: rule.fromPort,
    ToPort: rule.toPort,
    IpRanges: [{ CidrIp: rule.cidrIp, ...(rule.description ? { Description: rule.description } : {}) }],
  };
}

export async function executeSecurityGroupIngress(
  actionType: SecurityGroupActionType,
  groupId: string,
  params: Record<string, string | number>,
): Promise<ActionExecutionResult> {
  // Validate AGAIN at the execution layer. The router already validated, but `action-execution-fn`
  // is its own trust boundary (invokable by any principal with permission) — the caller can't be assumed trustworthy.
  const parsed = parseSecurityGroupIngressRule(params);
  if (!parsed.ok) {
    return { outcome: 'rejected', reason: `Invalid rule parameters at execution time: ${parsed.message}` };
  }
  const rule = parsed.rule;

  // Re-read the REAL state at execution time (don't trust preview data, which may be stale).
  let group: SecurityGroup | undefined;
  try {
    const { SecurityGroups = [] } = await ec2.send(new DescribeSecurityGroupsCommand({ GroupIds: [groupId] }));
    group = SecurityGroups[0];
  } catch (err) {
    if (awsErrorName(err).startsWith('InvalidGroup.NotFound')) {
      return { outcome: 'rejected', reason: `Security Group ${groupId} not found at execution time.` };
    }
    return {
      outcome: 'failure',
      reason: `Could not read the current state of Security Group ${groupId}: ${(err as Error).message}`,
    };
  }
  if (!group) {
    return { outcome: 'rejected', reason: `Security Group ${groupId} not found at execution time.` };
  }

  const exists = securityGroupHasIngressRule(group.IpPermissions, rule);
  const summary = describeSecurityGroupRule(actionType, rule);

  if (actionType === 'SecurityGroup_AuthorizeIngress' && exists) {
    return { outcome: 'rejected', reason: `Rule already exists on ${groupId} — no need to add it again: ${summary}` };
  }
  if (actionType === 'SecurityGroup_RevokeIngress' && !exists) {
    return { outcome: 'rejected', reason: `Rule to remove was not found on ${groupId}: ${summary}` };
  }

  const input = { GroupId: groupId, IpPermissions: [toIpPermission(rule)] };
  try {
    if (actionType === 'SecurityGroup_AuthorizeIngress') {
      await ec2.send(new AuthorizeSecurityGroupIngressCommand(input));
    } else {
      await ec2.send(new RevokeSecurityGroupIngressCommand(input));
    }
  } catch (err) {
    const benign = BENIGN_AWS_ERROR_REASONS[awsErrorName(err)];
    if (benign) {
      return { outcome: 'rejected', reason: benign };
    }
    const apiName =
      actionType === 'SecurityGroup_AuthorizeIngress'
        ? 'AuthorizeSecurityGroupIngress'
        : 'RevokeSecurityGroupIngress';
    return { outcome: 'failure', reason: `${apiName} failed for ${groupId}: ${(err as Error).message}` };
  }

  return { outcome: 'success', appliedSecurityGroupRule: summary };
}
