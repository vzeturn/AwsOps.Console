import { SENSITIVE_PORTS } from '@ops-dashboard/shared';
import type { SecurityGroupRuleView } from '@ops-dashboard/shared';
import { attributeResource } from '../../attribution.js';
import { arnFor } from '../../finding-id.js';
import { arnContext, makeDraft, type CheckDefinition } from '../types.js';

const WORLD_CIDRS: ReadonlySet<string> = new Set(['0.0.0.0/0', '::/0']);

/** Sensitive (admin/db) TCP ports this rule opens to the whole internet. */
export function exposedSensitivePorts(rule: SecurityGroupRuleView): number[] {
  const fromWorld = [rule.cidrIp, rule.sourceLabel].some((cidr) => cidr !== undefined && WORLD_CIDRS.has(cidr));
  if (!fromWorld) return [];
  const allTraffic = rule.protocol === '-1';
  if (!allTraffic && rule.protocol !== 'tcp') return [];
  return [...SENSITIVE_PORTS.keys()]
    .filter((port) => allTraffic || (rule.fromPort !== null && rule.toPort !== null && rule.fromPort <= port && port <= rule.toPort))
    .sort((a, b) => a - b);
}

/** Adapter over the existing Security Group source (listSecurityGroups). */
export const SG_WIDE_OPEN: CheckDefinition = {
  checkId: 'sec.sg-wide-open-sensitive-port',
  source: 'security-group',
  kpi: 'security',
  isoControls: ['A.8.20'],
  requires: ['topology', 'security-groups'],
  title: 'Security group opens admin/database ports to the internet',
  impact: 'Anyone on the internet can reach SSH/RDP/database ports - the most common entry point for brute force and exploitation.',
  remediation: ['Restrict the rule source to a known CIDR, VPN or security group.', 'Prefer SSM Session Manager over inbound SSH/RDP.'],
  run: (snapshot) =>
    (snapshot.securityGroups ?? []).flatMap((group) => {
      const exposed = group.ingressRules.flatMap((rule) => exposedSensitivePorts(rule).map((port) => ({ port, rule })));
      if (exposed.length === 0) return [];
      const ports = [...new Set(exposed.map((e) => e.port))].sort((a, b) => a - b);
      return [
        makeDraft(SG_WIDE_OPEN, {
          resourceType: 'security-group',
          resourceId: group.groupId,
          resourceName: group.groupName,
          resourceArn: arnFor('security-group', group.groupId, arnContext(snapshot)),
          placement: attributeResource(snapshot.topologyIndex, group.groupId, { vpcId: group.vpcId }),
          severity: 'high',
          description: `${group.groupName} allows ${ports.map((p) => `${p}/${SENSITIVE_PORTS.get(p)}`).join(', ')} from 0.0.0.0/0 or ::/0`,
          observedAt: snapshot.observedAt['security-groups'] ?? snapshot.now,
          data: {
            groupId: group.groupId,
            groupName: group.groupName,
            exposedPorts: ports.map((port) => ({ port, service: SENSITIVE_PORTS.get(port) })),
            rules: exposed.map(({ rule }) => ({ protocol: rule.protocol, fromPort: rule.fromPort, toPort: rule.toPort, source: rule.cidrIp ?? rule.sourceLabel })),
          },
        }),
      ];
    }),
};
