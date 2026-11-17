import { ACCOUNT_SCOPE } from '@ops-dashboard/shared';
import type { SubnetTier, TopologyData } from '@ops-dashboard/shared';

export interface Placement {
  vpcId: string;
  subnetId?: string;
  az?: string;
}

export interface SubnetInfo {
  vpcId: string;
  availabilityZone: string;
  tier: SubnetTier;
  isPublic: boolean;
}

export interface TopologyIndex {
  placementById: ReadonlyMap<string, Placement>;
  subnetById: ReadonlyMap<string, SubnetInfo>;
  vpcIds: ReadonlySet<string>;
  /** VPCs with at least one placed resource (used to skip empty default VPCs). */
  placedVpcIds: ReadonlySet<string>;
}

export function buildTopologyIndex(topology: TopologyData): TopologyIndex {
  const subnetById = new Map<string, SubnetInfo>();
  const vpcIds = new Set<string>();
  for (const vpc of topology.vpcs) {
    vpcIds.add(vpc.vpcId);
    for (const subnet of vpc.subnets) {
      subnetById.set(subnet.subnetId, { vpcId: vpc.vpcId, availabilityZone: subnet.availabilityZone, tier: subnet.tier, isPublic: subnet.isPublic });
    }
  }
  const placementById = new Map<string, Placement>();
  const placedVpcIds = new Set<string>();
  for (const resource of [...topology.resources, ...topology.unplacedResources]) {
    if (!resource.vpcId) continue;
    const subnetId = resource.subnetIds[0];
    const az = resource.availabilityZone ?? (subnetId ? subnetById.get(subnetId)?.availabilityZone : undefined);
    placementById.set(resource.id, { vpcId: resource.vpcId, subnetId, az });
    placedVpcIds.add(resource.vpcId);
  }
  return { placementById, subnetById, vpcIds, placedVpcIds };
}

/**
 * Spec §3.1 VPC attribution. Order: topology placement, VPC id itself, subnet id, caller hint
 * (a source that already knows the VPC, e.g. SG.vpcId / GuardDuty ENI vpcId), else account-wide.
 */
export function attributeResource(index: TopologyIndex, resourceId: string, hint?: { vpcId?: string }): Placement {
  const placed = index.placementById.get(resourceId);
  if (placed) return placed;
  if (index.vpcIds.has(resourceId)) return { vpcId: resourceId };
  const subnet = index.subnetById.get(resourceId);
  if (subnet) return { vpcId: subnet.vpcId, subnetId: resourceId, az: subnet.availabilityZone };
  if (hint?.vpcId) return { vpcId: hint.vpcId };
  return { vpcId: ACCOUNT_SCOPE };
}
