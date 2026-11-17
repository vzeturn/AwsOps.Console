import { DescribeSecurityGroupsCommand } from '@aws-sdk/client-ec2';
import type { IpPermission, SecurityGroup } from '@aws-sdk/client-ec2';
import type { SecurityGroupRuleView, SecurityGroupSummary, SecurityGroupsResponse } from '@ops-dashboard/shared';
import { getEc2Client } from '../../core/aws-clients.js';

/**
 * Reads Security Groups for the "Security Group" tab — runs directly inside the router Lambda (no
 * dedicated Lambda), same pattern as `cloudwatch-logs-viewer-service.ts`. READ-ONLY only: `RouterRole`
 * has no mutate permissions at all (see the static test `action-execution-iam-and-imports.test.ts`).
 */
const ec2 = getEc2Client();

/** SG listing cap — same rationale as `MAX_LOG_GROUPS`: an uncapped pagination loop is a time bomb
 * against the Lambda timeout and the Function URL's 6 MB limit. Hitting the cap reports `truncated`. */
const MAX_SECURITY_GROUPS = 500;

/** The 3 protocols the dashboard can operate on — matches shared's `SecurityGroupProtocol`. A rule
 * outside this set (e.g. '-1' = all protocols) still DISPLAYS but can't be removed from the dashboard. */
const OPERABLE_PROTOCOLS: ReadonlySet<string> = new Set(['tcp', 'udp', 'icmp']);

/**
 * Flattens an `IpPermission` into one row per source. AWS groups multiple sources (multiple CIDRs,
 * multiple referenced SGs) into the SAME `IpPermission`, but an operator removes ONE CIDR rather
 * than the whole group — the UI table must reflect that as the real unit of operation.
 */
function flattenPermission(permission: IpPermission): SecurityGroupRuleView[] {
  const protocol = permission.IpProtocol ?? '-1';
  const fromPort = permission.FromPort ?? null;
  const toPort = permission.ToPort ?? null;
  const base = { protocol, fromPort, toPort };
  const rows: SecurityGroupRuleView[] = [];

  for (const range of permission.IpRanges ?? []) {
    if (!range.CidrIp) continue;
    rows.push({
      ...base,
      cidrIp: range.CidrIp,
      sourceLabel: range.CidrIp,
      // Removable ONLY when both the source (IPv4 CIDR) and the protocol fall within the
      // dashboard's operable scope — otherwise the "Remove" button is disabled with an
      // explanation instead of calling the API and failing.
      removable: OPERABLE_PROTOCOLS.has(protocol),
      ...(range.Description ? { description: range.Description } : {}),
    });
  }
  for (const range of permission.Ipv6Ranges ?? []) {
    if (!range.CidrIpv6) continue;
    rows.push({
      ...base,
      sourceLabel: range.CidrIpv6,
      removable: false,
      ...(range.Description ? { description: range.Description } : {}),
    });
  }
  for (const pair of permission.UserIdGroupPairs ?? []) {
    if (!pair.GroupId) continue;
    rows.push({
      ...base,
      sourceLabel: pair.GroupId,
      removable: false,
      ...(pair.Description ? { description: pair.Description } : {}),
    });
  }
  for (const prefix of permission.PrefixListIds ?? []) {
    if (!prefix.PrefixListId) continue;
    rows.push({
      ...base,
      sourceLabel: prefix.PrefixListId,
      removable: false,
      ...(prefix.Description ? { description: prefix.Description } : {}),
    });
  }
  return rows;
}

function toSummary(group: SecurityGroup): SecurityGroupSummary {
  return {
    groupId: group.GroupId ?? '',
    groupName: group.GroupName ?? '',
    vpcId: group.VpcId ?? '',
    description: group.Description ?? '',
    ingressRules: (group.IpPermissions ?? []).flatMap(flattenPermission),
    egressRules: (group.IpPermissionsEgress ?? []).flatMap(flattenPermission),
  };
}

export async function listSecurityGroups(): Promise<SecurityGroupsResponse> {
  const groups: SecurityGroupSummary[] = [];
  let nextToken: string | undefined;
  let truncated = false;

  do {
    const response = await ec2.send(new DescribeSecurityGroupsCommand({ NextToken: nextToken }));
    for (const group of response.SecurityGroups ?? []) {
      if (groups.length >= MAX_SECURITY_GROUPS) {
        truncated = true;
        break;
      }
      groups.push(toSummary(group));
    }
    nextToken = truncated ? undefined : response.NextToken;
  } while (nextToken);

  // Sort by name so the select's order stays stable across reloads — DescribeSecurityGroups makes
  // no ordering guarantee, and a list that reshuffles on every refetch is the easiest way to pick the wrong SG.
  groups.sort((a, b) => a.groupName.localeCompare(b.groupName));
  return { groups, truncated };
}
