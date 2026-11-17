import { AuthorizeSecurityGroupEgressCommand, RevokeSecurityGroupEgressCommand } from '@aws-sdk/client-ec2';
import { parseSecurityGroupEgressRule, type SecurityGroupEgressRule, type ActionExecutionResult } from '@ops-dashboard/shared';
import { getEc2Client } from '../../core/aws-clients.js';
import { logger } from '../../shared-kernel/logger.js';

/**
 * Runs inside `action-execution-fn`. Executes `SecurityGroup_AuthorizeEgress` /
 * `SecurityGroup_RevokeEgress` — mirrors the structure of `security-group-action-service.ts`
 * (ingress), differing only in which AWS API is called (Egress instead of Ingress).
 */
const ec2 = getEc2Client();

/** Same list of "benign" AWS error reasons (business rejection, not a system error) used in
 * security-group-action-service.ts — swapped to the egress context. */
const BENIGN_AWS_ERROR_REASONS: Record<string, string> = {
  'InvalidPermission.Duplicate': 'Rule already exists — no need to add it again.',
  'InvalidPermission.NotFound': 'The rule to remove was not found.',
  'InvalidGroup.NotFound': 'Security Group not found.',
};

function awsErrorName(err: unknown): string | undefined {
  return err && typeof err === 'object' && 'name' in err ? String((err as { name: unknown }).name) : undefined;
}

function toIpPermission(rule: SecurityGroupEgressRule) {
  return {
    IpProtocol: rule.protocol,
    FromPort: rule.fromPort,
    ToPort: rule.toPort,
    IpRanges: [{ CidrIp: rule.cidrIp, ...(rule.description ? { Description: rule.description } : {}) }],
  };
}

export async function executeSecurityGroupEgress(
  actionType: 'SecurityGroup_AuthorizeEgress' | 'SecurityGroup_RevokeEgress',
  groupId: string,
  params: Record<string, string | number>,
): Promise<ActionExecutionResult> {
  // Re-validates at the execution layer — the router already validated, but action-execution-fn is
  // a separate trust boundary and must not assume its caller is trustworthy.
  // parseSecurityGroupEgressRule does not trim/lowercase the protocol itself — pass the params
  // normalized to string as-is, matching the equivalent call in security-group-action-service.ts
  // (ingress).
  const stringParams = Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)]));
  const parsed = parseSecurityGroupEgressRule(stringParams);
  if (!parsed.ok) {
    return { outcome: 'failure', reason: parsed.message };
  }
  const permission = toIpPermission(parsed.rule);

  try {
    if (actionType === 'SecurityGroup_AuthorizeEgress') {
      await ec2.send(new AuthorizeSecurityGroupEgressCommand({ GroupId: groupId, IpPermissions: [permission] }));
    } else {
      await ec2.send(new RevokeSecurityGroupEgressCommand({ GroupId: groupId, IpPermissions: [permission] }));
    }
  } catch (err) {
    const name = awsErrorName(err);
    if (name && name in BENIGN_AWS_ERROR_REASONS) {
      return { outcome: 'rejected', reason: BENIGN_AWS_ERROR_REASONS[name] };
    }
    logger.error(`security-group-egress-action-service: ${actionType}(${groupId}) failed`, err);
    const message = err instanceof Error ? err.message : 'unknown error';
    return { outcome: 'failure', reason: message };
  }

  return { outcome: 'success' };
}
