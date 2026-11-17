import { attributeResource } from '../../attribution.js';
import { arnFor } from '../../finding-id.js';
import { arnContext, makeDraft, type CheckDefinition, type FindingsSnapshot, type RdsExposure } from '../types.js';

export const VPC_FLOW_LOGS_DISABLED: CheckDefinition = {
  checkId: 'net.vpc-flow-logs-disabled',
  source: 'network',
  kpi: 'network',
  isoControls: ['A.8.16'],
  requires: ['topology', 'flow-logs'],
  title: 'VPC Flow Logs disabled',
  impact: 'No record of accepted/rejected traffic - incidents in this VPC cannot be investigated after the fact.',
  remediation: ['Enable VPC Flow Logs (ALL traffic) to CloudWatch Logs or S3 with a retention policy.'],
  run: (snapshot) => {
    const active = new Set(snapshot.flowLogResourceIds ?? []);
    return snapshot.topology.vpcs
      .filter((vpc) => !active.has(vpc.vpcId))
      .filter((vpc) => !vpc.isDefault || snapshot.topologyIndex.placedVpcIds.has(vpc.vpcId))
      .map((vpc) =>
        makeDraft(VPC_FLOW_LOGS_DISABLED, {
          resourceType: 'vpc',
          resourceId: vpc.vpcId,
          resourceName: vpc.name,
          resourceArn: arnFor('vpc', vpc.vpcId, arnContext(snapshot)),
          placement: { vpcId: vpc.vpcId },
          severity: 'medium',
          description: `${vpc.name} (${vpc.vpcId}) has no active flow log`,
          observedAt: snapshot.observedAt['flow-logs'] ?? snapshot.now,
          data: { vpcId: vpc.vpcId, isDefault: vpc.isDefault },
        }),
      );
  },
};

export const DEFAULT_SG_NOT_EMPTY: CheckDefinition = {
  checkId: 'net.default-sg-not-empty',
  source: 'network',
  kpi: 'network',
  isoControls: ['A.8.20'],
  requires: ['topology', 'security-groups'],
  title: 'Default security group has rules',
  impact: 'Resources launched without an explicit SG silently inherit this traffic, bypassing review.',
  remediation: ['Remove every inbound and outbound rule from the default security group.', 'Attach purpose-built security groups to resources instead.'],
  run: (snapshot) =>
    (snapshot.securityGroups ?? [])
      .filter((g) => g.groupName === 'default' && g.ingressRules.length + g.egressRules.length > 0)
      .map((g) =>
        makeDraft(DEFAULT_SG_NOT_EMPTY, {
          resourceType: 'security-group',
          resourceId: g.groupId,
          resourceName: g.groupName,
          resourceArn: arnFor('security-group', g.groupId, arnContext(snapshot)),
          placement: attributeResource(snapshot.topologyIndex, g.groupId, { vpcId: g.vpcId }),
          severity: 'medium',
          description: `default SG in ${g.vpcId} has ${g.ingressRules.length} inbound / ${g.egressRules.length} outbound rule(s)`,
          observedAt: snapshot.observedAt['security-groups'] ?? snapshot.now,
          data: { groupId: g.groupId, vpcId: g.vpcId, ingressRuleCount: g.ingressRules.length, egressRuleCount: g.egressRules.length },
        }),
      ),
};

export const SINGLE_NAT_MULTI_AZ: CheckDefinition = {
  checkId: 'net.single-nat-multi-az',
  source: 'network',
  kpi: 'resilience',
  isoControls: ['A.5.30', 'A.8.14'],
  requires: ['topology'],
  title: 'Private subnets in several AZs share a single NAT gateway',
  impact: 'An outage of that NAT gateway or its AZ cuts outbound connectivity for every private subnet in the VPC.',
  remediation: ['Create one NAT gateway per AZ and point each private route table at the NAT in its own AZ.'],
  run: (snapshot) =>
    snapshot.topology.vpcs.flatMap((vpc) => {
      const natSubnets = vpc.subnets.filter((s) => s.egressVia?.kind === 'natgw');
      const natIds = [...new Set(natSubnets.map((s) => s.egressVia?.id ?? ''))];
      const azs = [...new Set(natSubnets.map((s) => s.availabilityZone))].sort();
      if (natIds.length !== 1 || azs.length < 2) return [];
      const natId = natIds[0];
      return [
        makeDraft(SINGLE_NAT_MULTI_AZ, {
          resourceType: 'nat-gateway',
          resourceId: natId,
          resourceArn: arnFor('nat-gateway', natId, arnContext(snapshot)),
          placement: attributeResource(snapshot.topologyIndex, natId, { vpcId: vpc.vpcId }),
          severity: 'medium',
          description: `${natSubnets.length} private subnet(s) across ${azs.join(', ')} all egress via ${natId}`,
          observedAt: snapshot.observedAt.topology ?? snapshot.now,
          data: { natGatewayId: natId, availabilityZones: azs, subnetIds: natSubnets.map((s) => s.subnetId) },
        }),
      ];
    }),
};

function rdsDraftBase(snapshot: FindingsSnapshot, db: RdsExposure) {
  return {
    resourceType: 'rds-instance',
    resourceId: db.dbInstanceIdentifier,
    resourceName: db.dbInstanceIdentifier,
    resourceArn: db.dbInstanceArn || arnFor('rds-instance', db.dbInstanceIdentifier, arnContext(snapshot)),
    placement: attributeResource(snapshot.topologyIndex, db.dbInstanceIdentifier, { vpcId: db.vpcId }),
    observedAt: snapshot.observedAt.rds ?? snapshot.now,
  };
}

export const RDS_PUBLICLY_ACCESSIBLE: CheckDefinition = {
  checkId: 'net.rds-publicly-accessible',
  source: 'network',
  kpi: 'security',
  isoControls: ['A.8.22'],
  requires: ['topology', 'rds'],
  title: 'RDS instance is publicly accessible',
  impact: 'The database endpoint resolves to a public IP; only its security group stands between it and the internet.',
  remediation: ['Modify the DB instance and set PubliclyAccessible to false.', 'Reach the database through the VPC (bastion via SSM, VPN or app tier) instead.'],
  run: (snapshot) =>
    (snapshot.rdsInstances ?? [])
      .filter((db) => db.publiclyAccessible)
      .map((db) =>
        makeDraft(RDS_PUBLICLY_ACCESSIBLE, {
          ...rdsDraftBase(snapshot, db),
          severity: 'high',
          description: `${db.dbInstanceIdentifier} has PubliclyAccessible=true`,
          data: { dbInstanceIdentifier: db.dbInstanceIdentifier, publiclyAccessible: true },
        }),
      ),
};

/** Placed subnet (topology) is authoritative; if the DB is not in topology, any public subnet in
 * its DB subnet group is enough (a failover can land it there). */
function publicSubnetsOf(snapshot: FindingsSnapshot, db: RdsExposure): string[] {
  const placedSubnet = snapshot.topologyIndex.placementById.get(db.dbInstanceIdentifier)?.subnetId;
  const candidates = placedSubnet ? [placedSubnet] : db.subnetIds;
  return candidates.filter((id) => snapshot.topologyIndex.subnetById.get(id)?.isPublic === true);
}

export const RDS_IN_PUBLIC_SUBNET: CheckDefinition = {
  checkId: 'net.rds-in-public-subnet',
  source: 'network',
  kpi: 'network',
  isoControls: ['A.8.22'],
  requires: ['topology', 'rds'],
  title: 'RDS instance is placed in a public subnet',
  impact: 'The database shares a subnet routed to an internet gateway, breaking network segregation.',
  remediation: ['Move the DB subnet group to private/isolated subnets only (requires a maintenance window).'],
  run: (snapshot) =>
    (snapshot.rdsInstances ?? []).flatMap((db) => {
      const publicSubnets = publicSubnetsOf(snapshot, db);
      if (publicSubnets.length === 0) return [];
      return [
        makeDraft(RDS_IN_PUBLIC_SUBNET, {
          ...rdsDraftBase(snapshot, db),
          severity: 'medium',
          description: `${db.dbInstanceIdentifier} uses public subnet(s) ${publicSubnets.join(', ')}`,
          data: { dbInstanceIdentifier: db.dbInstanceIdentifier, publicSubnetIds: publicSubnets },
        }),
      ];
    }),
};
