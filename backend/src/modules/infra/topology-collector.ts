import {
  DescribeVpcsCommand,
  DescribeSubnetsCommand,
  DescribeRouteTablesCommand,
  DescribeInstancesCommand,
  DescribeNatGatewaysCommand,
  DescribeTransitGatewaysCommand,
  DescribeTransitGatewayVpcAttachmentsCommand,
  type RouteTable,
} from '@aws-sdk/client-ec2';
import { DescribeDBInstancesCommand } from '@aws-sdk/client-rds';
import { ListBucketsCommand } from '@aws-sdk/client-s3';
import {
  DescribeLoadBalancersCommand,
  DescribeTargetGroupsCommand,
  DescribeTargetHealthCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import {
  ListClustersCommand,
  ListServicesCommand,
  DescribeServicesCommand,
} from '@aws-sdk/client-ecs';
import {
  INTERNET_NODE_ID,
  type SubnetTier,
  type TopologyData,
  type TopologyEdge,
  type TopologyResource,
  type TopologySubnet,
  type TopologyVpc,
} from '@ops-dashboard/shared';
import { logger } from '../../shared-kernel/logger.js';
import { fetchAllPages } from '../../core/pagination.js';
import { nameTagOr } from '../../core/awsTags.js';
import {
  getEc2Client,
  getRdsClient,
  getS3Client,
  getElasticLoadBalancingV2Client,
  getEcsClient,
} from '../../core/aws-clients.js';

/**
 * `topology-collector.ts` — collects the STRUCTURE of the account's network: VPCs, their subnets,
 * whether each subnet is genuinely public, and which resource sits in which subnet. Feeds the Infra
 * Map page.
 *
 * COST: every API called here is free (`ec2:Describe*`, `rds:DescribeDBInstances`,
 * `elasticloadbalancing:DescribeLoadBalancers`, `ecs:*List/Describe`, `s3:ListAllMyBuckets`). There is
 * deliberately NO CloudWatch call — `GetMetricData` costs money, and this collector needs no metrics
 * because health is joined client-side from `/monitoring` (see the comment on `TopologyData` in
 * shared).
 *
 * FAILURE MODEL: each resource family is fetched independently and a failure in one returns an empty
 * list for that family only, logged loudly. The VPC/subnet fetch is the exception — without it there
 * is no map at all, so that error propagates and the collector leaves the previous cache in place
 * rather than overwriting it with a structurally empty map. An empty map that renders successfully
 * would claim "you have no infrastructure", which is the worst possible lie for this page to tell.
 */

const AWS_REGION = process.env.AWS_REGION as string;

// Local alias kept so the rest of this file's many call sites don't need touching — the real
// implementation now lives in core/awsTags.ts (shared with every other module that needs the same
// "Name tag or fallback" display pattern).
const nameTag = nameTagOr;

/**
 * Whether a route table sends the default route to a WORKING internet gateway.
 *
 * Three conditions, and each one was needed to get a real account right:
 *
 * 1. The destination must be a default route — IPv4 `0.0.0.0/0` or IPv6 `::/0`.
 *
 * 2. The target must be an `igw-` gateway. A default route via a NAT gateway, transit gateway or VPC
 *    endpoint does NOT make a subnet public; treating any default route as internet access would
 *    mislabel every private subnet that reaches out through NAT, which is most of them.
 *
 * 3. The route must be `State === 'active'`. THIS ONE IS NOT THEORETICAL — it was found on
 *    `abc-prod` (2026-09-07). The default VPC `vpc-0a1b2c3d` still carries
 *    `0.0.0.0/0 -> igw-0a1b2c3d` in its main route table, but that gateway has since been attached to
 *    a DIFFERENT VPC (`vpc-0a1b2c3d4e5f60001`). AWS does not delete the orphaned route; it leaves it
 *    with `State: 'blackhole'`. Without this check, both subnets of that VPC were reported PUBLIC
 *    while having no path to the internet whatsoever.
 *
 *    That error direction is the dangerous one for a security-facing diagram: it invents exposure
 *    that does not exist, and an operator acting on it would go looking for a hole that is not there
 *    — or worse, learn to distrust the map.
 */
function isUsableDefaultRoute(route: { DestinationCidrBlock?: string; DestinationIpv6CidrBlock?: string; State?: string }): boolean {
  const isDefault = route.DestinationCidrBlock === '0.0.0.0/0' || route.DestinationIpv6CidrBlock === '::/0';
  // A blackhole route points at a gateway that is gone or attached elsewhere: no connectivity.
  return isDefault && route.State === 'active';
}

function routesToInternetGateway(routeTable: RouteTable | undefined): boolean {
  return (routeTable?.Routes ?? []).some(
    (route) => isUsableDefaultRoute(route) && (route.GatewayId ?? '').startsWith('igw-'),
  );
}

/**
 * Whether a route table has ANY usable default route that is not a plain internet gateway.
 *
 * Deliberately broad. The question the tier answers is "can traffic leave this subnet without the subnet
 * itself being directly internet-exposed", and the answer is yes for a managed NAT gateway, an EC2 NAT or
 * proxy instance, an egress-only internet gateway (the IPv6 outbound-only device), a transit gateway, or a
 * peering connection. Enumerating only the targets we happen to think of is how `isolated` ends up
 * asserted about a subnet that plainly has a way out — and `isolated` is the strongest claim this data
 * makes, so being wrong about it is worse than being unspecific.
 */
function hasNonInternetEgress(routeTable: RouteTable | undefined): boolean {
  return (routeTable?.Routes ?? []).some(
    (route) =>
      isUsableDefaultRoute(route) &&
      !(route.GatewayId ?? '').startsWith('igw-') &&
      Boolean(
        route.NatGatewayId ||
          route.InstanceId ||
          route.NetworkInterfaceId ||
          route.EgressOnlyInternetGatewayId ||
          route.TransitGatewayId ||
          route.VpcPeeringConnectionId ||
          route.CarrierGatewayId ||
          route.LocalGatewayId ||
          route.GatewayId,
      ),
  );
}

/**
 * The egress target a subnet's default route points at, when it is something the map can draw.
 *
 * Handles BOTH kinds of NAT, because AWS reports them nothing alike:
 *
 *   managed NAT gateway  ->  `NatGatewayId: 'nat-...'`
 *   EC2 NAT instance     ->  `InstanceId: 'i-...'` + `NetworkInterfaceId: 'eni-...'`, no NatGatewayId
 *
 * The instance id is preferred over the ENI because the instance is a node on this map and the ENI is not.
 * A transit gateway or peering connection still counts as egress for the tier (see `hasNonInternetEgress`)
 * but returns nothing here: there is no node to point at, and inventing one is worse than an unlabelled
 * band.
 */
function egressTarget(
  routeTable: RouteTable | undefined,
): { id: string; kind: 'natgw' | 'instance' } | undefined {
  for (const route of routeTable?.Routes ?? []) {
    if (!isUsableDefaultRoute(route)) continue;
    if (route.NatGatewayId) return { id: route.NatGatewayId, kind: 'natgw' };
    // A default route to an instance is the NAT-instance pattern — or a firewall/proxy appliance, which
    // behaves the same way for this purpose: outbound works, inbound from the internet does not.
    if (route.InstanceId) return { id: route.InstanceId, kind: 'instance' };
  }
  return undefined;
}

/**
 * The Transit Gateway a subnet's route table ACTIVELY routes through, scanned across EVERY route in
 * the table — not only the default `0.0.0.0/0` one.
 *
 * That is the opposite scope from `egressTarget`/`hasNonInternetEgress` above, and deliberately so:
 * those two are specifically about the subnet's DEFAULT route, because that is what decides whether
 * the subnet can reach the general internet. A Transit Gateway is most often wired in for something
 * narrower — a specific CIDR for another VPC, an on-prem block reached over Direct Connect/VPN — so a
 * TGW route on a real account is more often a non-default entry than the default one. Only checking
 * the default route here would miss the majority of real Transit Gateway usage.
 *
 * `State !== 'active'` is excluded for the same blackhole reason `isUsableDefaultRoute` exists at all:
 * a route table can keep a stale entry pointing at an attachment that no longer carries traffic.
 */
function tgwRouteTarget(routeTable: RouteTable | undefined): string | undefined {
  for (const route of routeTable?.Routes ?? []) {
    if (route.State !== 'active') continue;
    if (route.TransitGatewayId) return route.TransitGatewayId;
  }
  return undefined;
}

/**
 * A subnet's architectural role, from its route table.
 *
 * The order matters: a subnet with BOTH an internet-gateway route and a NAT route is `public` — direct
 * internet reachability is the property that defines the edge tier, and it dominates. `isolated` is the
 * absence of ANY usable default route, so it is only claimed when nothing at all routes out.
 */
function subnetTier(routeTable: RouteTable | undefined): SubnetTier {
  if (routesToInternetGateway(routeTable)) return 'public';
  if (hasNonInternetEgress(routeTable)) return 'private';
  return 'isolated';
}

/** Paginates DescribeRouteTables and indexes the result the two ways subnet classification needs it:
 * by explicitly associated subnet, and by the VPC whose MAIN table it is. */
async function loadRouteTableIndex(): Promise<{
  bySubnetId: Map<string, RouteTable>;
  mainByVpcId: Map<string, RouteTable>;
}> {
  const bySubnetId = new Map<string, RouteTable>();
  const mainByVpcId = new Map<string, RouteTable>();
  let nextToken: string | undefined;
  do {
    const { RouteTables = [], NextToken } = await getEc2Client().send(new DescribeRouteTablesCommand({ NextToken: nextToken }));
    for (const rt of RouteTables) {
      for (const assoc of rt.Associations ?? []) {
        if (assoc.SubnetId) bySubnetId.set(assoc.SubnetId, rt);
        // `Main` marks the table used by any subnet with no explicit association.
        if (assoc.Main && rt.VpcId) mainByVpcId.set(rt.VpcId, rt);
      }
    }
    nextToken = NextToken;
  } while (nextToken);
  return { bySubnetId, mainByVpcId };
}

async function loadVpcs(): Promise<TopologyVpc[]> {
  const { bySubnetId, mainByVpcId } = await loadRouteTableIndex();

  const vpcs: TopologyVpc[] = [];
  let vpcToken: string | undefined;
  do {
    const { Vpcs = [], NextToken } = await getEc2Client().send(new DescribeVpcsCommand({ NextToken: vpcToken }));
    for (const vpc of Vpcs) {
      if (!vpc.VpcId) continue;
      vpcs.push({
        vpcId: vpc.VpcId,
        name: nameTag(vpc.Tags, vpc.IsDefault ? '(default VPC)' : vpc.VpcId),
        cidrBlock: vpc.CidrBlock ?? '',
        isDefault: vpc.IsDefault ?? false,
        subnets: [],
      });
    }
    vpcToken = NextToken;
  } while (vpcToken);

  const byVpcId = new Map(vpcs.map((v) => [v.vpcId, v]));

  let subnetToken: string | undefined;
  do {
    const { Subnets = [], NextToken } = await getEc2Client().send(new DescribeSubnetsCommand({ NextToken: subnetToken }));
    for (const subnet of Subnets) {
      if (!subnet.SubnetId || !subnet.VpcId) continue;
      const parent = byVpcId.get(subnet.VpcId);
      if (!parent) continue;

      const routeTable = bySubnetId.get(subnet.SubnetId) ?? mainByVpcId.get(subnet.VpcId);
      const tier = subnetTier(routeTable);
      parent.subnets.push({
        subnetId: subnet.SubnetId,
        name: nameTag(subnet.Tags, subnet.SubnetId),
        cidrBlock: subnet.CidrBlock ?? '',
        availabilityZone: subnet.AvailabilityZone ?? '',
        tier,
        // Only for the private tier: the field means "the appliance this tier leaves through", which is
        // not a meaningful thing to say about a public subnet whose egress is its internet gateway.
        egressVia: tier === 'private' ? egressTarget(routeTable) : undefined,
        // Independent of `tier`, unlike `egressVia` above — see the field's own doc comment in shared.
        tgwId: tgwRouteTarget(routeTable),
        // Kept alongside `tier` because existing consumers read it; `tier === 'public'` is the same fact
        // with more resolution.
        isPublic: tier === 'public',
        availableIpCount: subnet.AvailableIpAddressCount ?? 0,
      });
    }
    subnetToken = NextToken;
  } while (subnetToken);

  // Stable ordering so the rendered map does not reshuffle between refreshes — an infrastructure
  // diagram whose boxes move on every poll is unreadable.
  for (const vpc of vpcs) {
    vpc.subnets.sort(
      (a: TopologySubnet, b: TopologySubnet) =>
        a.availabilityZone.localeCompare(b.availabilityZone) || a.subnetId.localeCompare(b.subnetId),
    );
  }
  vpcs.sort((a, b) => Number(a.isDefault) - Number(b.isDefault) || a.name.localeCompare(b.name));
  return vpcs;
}

async function loadEc2Placement(): Promise<TopologyResource[]> {
  const result: TopologyResource[] = [];
  let nextToken: string | undefined;
  do {
    const { Reservations = [], NextToken } = await getEc2Client().send(new DescribeInstancesCommand({ NextToken: nextToken }));
    for (const reservation of Reservations) {
      for (const instance of reservation.Instances ?? []) {
        const state = instance.State?.Name ?? 'unknown';
        // A terminated instance still appears in DescribeInstances for up to an hour but no longer
        // occupies its subnet — drawing it would show capacity that does not exist.
        if (!instance.InstanceId || state === 'terminated') continue;
        result.push({
          id: instance.InstanceId,
          kind: 'ec2',
          name: nameTag(instance.Tags, instance.InstanceId),
          state,
          detail: instance.InstanceType ?? '',
          vpcId: instance.VpcId,
          subnetIds: instance.SubnetId ? [instance.SubnetId] : [],
          availabilityZone: instance.Placement?.AvailabilityZone,
          monitoringType: 'ec2',
        });
      }
    }
    nextToken = NextToken;
  } while (nextToken);
  return result;
}

async function loadRdsPlacement(): Promise<TopologyResource[]> {
  // DescribeDBInstances returns a bounded page (Marker in/out) — paginated via fetchAllPages
  // (core/pagination.ts) so an account with more RDS instances than fit on one page is not
  // silently truncated on the Infra Map.
  const DBInstances = await fetchAllPages(async (marker) => {
    const { DBInstances: page = [], Marker } = await getRdsClient().send(new DescribeDBInstancesCommand({ Marker: marker }));
    return { items: page, nextToken: Marker };
  });
  return DBInstances.filter((db) => db.DBInstanceIdentifier).map((db) => ({
    id: db.DBInstanceIdentifier as string,
    kind: 'rds' as const,
    name: db.DBInstanceIdentifier as string,
    state: db.DBInstanceStatus ?? 'unknown',
    detail: [db.Engine, db.DBInstanceClass].filter(Boolean).join(' · '),
    vpcId: db.DBSubnetGroup?.VpcId,
    // An RDS instance is placed in a SUBNET GROUP spanning several AZs, but only actually runs in
    // one. Report every subnet of the group so a Multi-AZ deployment is visibly spread, and keep
    // `availabilityZone` as the one it currently occupies.
    subnetIds: (db.DBSubnetGroup?.Subnets ?? [])
      .map((s) => s.SubnetIdentifier)
      .filter((id): id is string => Boolean(id)),
    availabilityZone: db.AvailabilityZone,
    monitoringType: 'rds' as const,
  }));
}

/**
 * Load-balancer edges: which target is actually registered behind each load balancer.
 *
 * `DescribeTargetHealth` returns the REGISTERED targets, so this is the real traffic path rather than an
 * inference from names or security groups. Two target id shapes exist:
 *
 *   instance targets -> the id IS the EC2 instance id, which matches a node on the map directly.
 *   ip targets       -> an IP address, used by awsvpc ECS services. An IP is not a node, so the edge is
 *                       resolved instead through the ECS service's own `loadBalancers` block, which
 *                       names the target group it registers with. Guessing which service owns an IP
 *                       would be exactly the kind of invented dependency this must not produce.
 */
async function loadLoadBalancerEdges(
  ecsTargetGroups: Map<string, string>,
): Promise<{ edges: TopologyEdge[] }> {
  const edges: TopologyEdge[] = [];
  // DescribeLoadBalancers returns a bounded page (Marker in/out, NextMarker on the response) —
  // paginated via fetchAllPages (core/pagination.ts) so an account with more load balancers than
  // fit on one page does not silently lose edges for the ones past page 1.
  const LoadBalancers = await fetchAllPages(async (marker) => {
    const { LoadBalancers: page = [], NextMarker } = await getElasticLoadBalancingV2Client().send(new DescribeLoadBalancersCommand({ Marker: marker }));
    return { items: page, nextToken: NextMarker };
  });

  for (const lb of LoadBalancers) {
    const lbName = lb.LoadBalancerName;
    if (!lbName) continue;

    // An internet-facing load balancer is where traffic enters the account. Drawing that entry point is
    // what makes the diagram show direction of flow rather than just adjacency.
    if (lb.Scheme === 'internet-facing') {
      edges.push({ from: INTERNET_NODE_ID, to: lbName, kind: 'ingress-from' });
    }

    const { TargetGroups = [] } = await getElasticLoadBalancingV2Client().send(
      new DescribeTargetGroupsCommand({ LoadBalancerArn: lb.LoadBalancerArn }),
    );

    for (const tg of TargetGroups) {
      if (!tg.TargetGroupArn) continue;

      const ecsService = ecsTargetGroups.get(tg.TargetGroupArn);
      if (ecsService) {
        edges.push({ from: lbName, to: ecsService, kind: 'balances-to' });
        continue;
      }

      const { TargetHealthDescriptions = [] } = await getElasticLoadBalancingV2Client().send(
        new DescribeTargetHealthCommand({ TargetGroupArn: tg.TargetGroupArn }),
      );
      for (const target of TargetHealthDescriptions) {
        const id = target.Target?.Id;
        // Only instance ids map to a node. An IP target with no matching ECS service is skipped rather
        // than drawn against a made-up node.
        if (id && id.startsWith('i-')) edges.push({ from: lbName, to: id, kind: 'balances-to' });
      }
    }
  }

  return { edges };
}

async function loadLoadBalancerPlacement(): Promise<TopologyResource[]> {
  // Same pagination reasoning as loadLoadBalancerEdges above — a SEPARATE call site (own
  // DescribeLoadBalancers call), so paginated independently rather than sharing a cached result,
  // matching how this function was already structured before this fix.
  const LoadBalancers = await fetchAllPages(async (marker) => {
    const { LoadBalancers: page = [], NextMarker } = await getElasticLoadBalancingV2Client().send(new DescribeLoadBalancersCommand({ Marker: marker }));
    return { items: page, nextToken: NextMarker };
  });
  return LoadBalancers.filter((lb) => lb.LoadBalancerName).map((lb) => ({
    id: lb.LoadBalancerName as string,
    // Network load balancers are drawn too, even though /monitoring only covers ALBs (different
    // namespace, no TargetResponseTime). Leaving an NLB off the map would hide a real component of
    // the architecture; it simply gets no monitoringType and so is not clickable through to metrics.
    kind: lb.Type === 'network' ? ('nlb' as const) : ('alb' as const),
    name: lb.LoadBalancerName as string,
    state: lb.State?.Code ?? 'unknown',
    detail: lb.Scheme ?? '',
    vpcId: lb.VpcId,
    subnetIds: (lb.AvailabilityZones ?? [])
      .map((az) => az.SubnetId)
      .filter((id): id is string => Boolean(id)),
    monitoringType: lb.Type === 'network' ? undefined : ('alb' as const),
  }));
}

async function loadNatGatewayPlacement(): Promise<TopologyResource[]> {
  const result: TopologyResource[] = [];
  let nextToken: string | undefined;
  do {
    const { NatGateways = [], NextToken } = await getEc2Client().send(
      new DescribeNatGatewaysCommand({ NextToken: nextToken }),
    );
    for (const nat of NatGateways) {
      if (!nat.NatGatewayId) continue;
      if (nat.State === 'deleted') continue;
      result.push({
        id: nat.NatGatewayId,
        kind: 'natgw',
        name: nameTag(nat.Tags, nat.NatGatewayId),
        state: nat.State ?? 'unknown',
        detail: nat.ConnectivityType ?? 'public',
        vpcId: nat.VpcId,
        subnetIds: nat.SubnetId ? [nat.SubnetId] : [],
      });
    }
    nextToken = NextToken;
  } while (nextToken);
  return result;
}

/**
 * Transit Gateways — an ACCOUNT-LEVEL resource with no `vpcId`/`subnetIds` of its own, unlike every
 * other resource this collector reports. A TGW routes traffic BETWEEN VPCs by design, so pinning it
 * inside one would misrepresent what it is; it is drawn outside every VPC box instead (see
 * `TopologyData.accountResources`) and connected to the VPCs it actually serves via the `attached-to`
 * edges built by `loadTransitGatewayEdges` below.
 */
async function loadTransitGatewayPlacement(): Promise<TopologyResource[]> {
  const result: TopologyResource[] = [];
  let nextToken: string | undefined;
  do {
    const { TransitGateways = [], NextToken } = await getEc2Client().send(
      new DescribeTransitGatewaysCommand({ NextToken: nextToken }),
    );
    for (const tgw of TransitGateways) {
      if (!tgw.TransitGatewayId) continue;
      // `deleting`/`deleted` linger in the list output for a while after removal, same as a NAT
      // gateway does — drawing them would show connectivity that no longer exists.
      if (tgw.State === 'deleting' || tgw.State === 'deleted') continue;
      result.push({
        id: tgw.TransitGatewayId,
        kind: 'tgw',
        name: nameTag(tgw.Tags, tgw.TransitGatewayId),
        state: tgw.State ?? 'unknown',
        detail: tgw.Description ?? '',
        subnetIds: [],
      });
    }
    nextToken = NextToken;
  } while (nextToken);
  return result;
}

/**
 * `attached-to` edges: one per REAL, currently-`available` (transit gateway, VPC) pair.
 *
 * `DescribeTransitGatewayVpcAttachments` is the authoritative statement of which VPCs a TGW actually
 * connects — the same kind of concrete evidence `balances-to`/`egress-via` already require, and
 * exactly why this is drawn as an edge at all rather than an unlabelled box (see the doc comment on
 * `TopologyEdge`'s `attached-to` case in shared). Restricted to TGWs and VPCs that both already
 * exist on the map: an attachment naming either one this collector filtered out (a deleted TGW, a VPC
 * not returned by `DescribeVpcs`) would be an arrow to something invisible.
 */
async function loadTransitGatewayEdges(
  knownVpcIds: Set<string>,
  knownTgwIds: Set<string>,
): Promise<TopologyEdge[]> {
  const edges: TopologyEdge[] = [];
  let nextToken: string | undefined;
  do {
    const { TransitGatewayVpcAttachments = [], NextToken } = await getEc2Client().send(
      new DescribeTransitGatewayVpcAttachmentsCommand({ NextToken: nextToken }),
    );
    for (const attachment of TransitGatewayVpcAttachments) {
      if (attachment.State !== 'available') continue;
      const tgwId = attachment.TransitGatewayId;
      const vpcId = attachment.VpcId;
      if (!tgwId || !vpcId) continue;
      if (!knownTgwIds.has(tgwId) || !knownVpcIds.has(vpcId)) continue;
      edges.push({ from: tgwId, to: vpcId, kind: 'attached-to' });
    }
    nextToken = NextToken;
  } while (nextToken);
  return edges;
}

/**
 * Refines each VPC-level `attached-to` edge (`tgwId -> vpcId`, from `loadTransitGatewayEdges`) down to
 * the SPECIFIC subnet(s) whose own route table actually names that Transit Gateway
 * (`TopologySubnet.tgwId`), when that evidence exists.
 *
 * WHY THIS EXISTS. `DescribeTransitGatewayVpcAttachments` only proves the attachment EXISTS between a
 * TGW and a VPC — it says nothing about which part of the VPC uses it. Landing the edge on the VPC's
 * outer box is honest but coarse: on a VPC with three tiers, the reader cannot tell whether the TGW
 * serves the private application tier, the isolated data tier, or all of them. A subnet's OWN route
 * table naming that TGW is stronger, tier-specific evidence of the same relationship — not a new claim,
 * just a sharper location for the one already proven by the attachment.
 *
 * FALLS BACK to the original VPC-level edge, unchanged, when no subnet in that VPC corroborates the
 * attachment with a route. That happens for a real reason, not a data gap: an attachment can exist
 * (e.g. for future use, or serving a peer VPC's route back through this one) while nothing in THIS VPC's
 * own route tables currently sends traffic to it. Dropping the edge in that case would understate a
 * real, `available` attachment; keeping the coarse VPC-level line is the honest middle ground between
 * "invent a tier" and "say nothing at all".
 *
 * One VPC-level attachment can refine into SEVERAL subnet-level edges (e.g. both AZ's private subnets
 * route to the same TGW) — that is correct, not a duplicate: each is real, distinct route-table
 * evidence, and deduplication in `collectTopology` already collapses two subnets that happen to be the
 * exact same (from, to, kind) triple, which these are not (different `to`).
 */
function refineTransitGatewayEdgesWithSubnetEvidence(
  vpcLevelEdges: TopologyEdge[],
  vpcs: TopologyVpc[],
): TopologyEdge[] {
  const subnetsByVpcId = new Map(vpcs.map((v) => [v.vpcId, v.subnets]));
  const refined: TopologyEdge[] = [];

  for (const edge of vpcLevelEdges) {
    const corroborating = (subnetsByVpcId.get(edge.to) ?? []).filter((s) => s.tgwId === edge.from);
    if (corroborating.length === 0) {
      refined.push(edge);
      continue;
    }
    for (const subnet of corroborating) {
      refined.push({ from: edge.from, to: subnet.subnetId, kind: 'attached-to' });
    }
  }
  return refined;
}

/**
 * S3 buckets, listed but deliberately given NO edges.
 *
 * This is the one resource family this collector shows without also drawing a relationship for it.
 * A VPC Gateway Endpoint's route table entry targets the S3 PREFIX LIST for the whole region, not any
 * one bucket — there is no AWS API that reports "this VPC's traffic reaches THIS bucket" the way
 * `DescribeTargetHealth` reports which instance an ALB actually balances to. Drawing a `vpc -> bucket`
 * line would be exactly the invented dependency this map's own design rejects everywhere else, so a
 * bucket is listed as an account-level resource and left unconnected — an honest amount of connection
 * for the evidence actually available.
 */
async function loadS3BucketPlacement(): Promise<TopologyResource[]> {
  const { Buckets = [] } = await getS3Client().send(new ListBucketsCommand({}));
  return Buckets.filter((bucket) => bucket.Name).map((bucket) => ({
    id: bucket.Name as string,
    kind: 's3' as const,
    name: bucket.Name as string,
    state: 'available',
    subnetIds: [],
  }));
}

/** targetGroupArn -> `<cluster>/<service>`, so a load balancer edge can name the ECS service behind an
 *  IP target instead of the IP. Built from the service's own `loadBalancers` block, which is the
 *  authoritative statement of that relationship. */
async function loadEcsTargetGroupMap(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const { clusterArns = [] } = await getEcsClient().send(new ListClustersCommand({}));

  for (const clusterArn of clusterArns) {
    const { serviceArns = [] } = await getEcsClient().send(new ListServicesCommand({ cluster: clusterArn }));
    if (serviceArns.length === 0) continue;
    const { services = [] } = await getEcsClient().send(
      new DescribeServicesCommand({ cluster: clusterArn, services: serviceArns }),
    );
    const clusterName = clusterArn.split('/').pop() ?? clusterArn;
    for (const service of services) {
      if (!service.serviceName) continue;
      for (const lb of service.loadBalancers ?? []) {
        if (lb.targetGroupArn) map.set(lb.targetGroupArn, `${clusterName}/${service.serviceName}`);
      }
    }
  }
  return map;
}

async function loadEcsPlacement(): Promise<TopologyResource[]> {
  const { clusterArns = [] } = await getEcsClient().send(new ListClustersCommand({}));
  const result: TopologyResource[] = [];

  for (const clusterArn of clusterArns) {
    const { serviceArns = [] } = await getEcsClient().send(new ListServicesCommand({ cluster: clusterArn }));
    if (serviceArns.length === 0) continue;
    const { services = [] } = await getEcsClient().send(
      new DescribeServicesCommand({ cluster: clusterArn, services: serviceArns }),
    );
    const clusterName = clusterArn.split('/').pop() ?? clusterArn;

    for (const service of services) {
      if (!service.serviceName) continue;
      // Only `awsvpc` services have their own subnets. A bridge/host-network service runs inside its
      // container instance's ENI, so it has no subnet of its own and is reported unplaced rather
      // than being drawn in a subnet it does not actually occupy.
      const subnets = service.networkConfiguration?.awsvpcConfiguration?.subnets ?? [];
      result.push({
        id: `${clusterName}/${service.serviceName}`,
        kind: 'ecs',
        name: service.serviceName,
        state: service.status ?? 'unknown',
        detail: `${service.runningCount ?? 0}/${service.desiredCount ?? 0} tasks · ${clusterName}`,
        subnetIds: subnets,
        monitoringType: 'ecs',
      });
    }
  }
  return result;
}

/** Runs one family and turns a failure into an empty list, so a single permission gap or throttle
 * cannot blank out the whole map. */
async function safely(
  label: string,
  load: () => Promise<TopologyResource[]>,
): Promise<TopologyResource[]> {
  try {
    return await load();
  } catch (err) {
    logger.error(`topology-collector: ${label} failed (skipping that family, map still renders)`, err);
    return [];
  }
}

export async function collectTopology(): Promise<TopologyData> {
  // Deliberately NOT wrapped in `safely`: with no VPCs there is no map, and writing a structurally
  // empty map over a good cache would tell the operator they have no infrastructure.
  const vpcs = await loadVpcs();

  const [families, accountFamilies] = await Promise.all([
    Promise.all([
      safely('EC2 placement', loadEc2Placement),
      safely('RDS placement', loadRdsPlacement),
      safely('load balancer placement', loadLoadBalancerPlacement),
      safely('NAT gateway placement', loadNatGatewayPlacement),
      safely('ECS placement', loadEcsPlacement),
    ]),
    // Kept as a SEPARATE Promise.all rather than folded into the one above: these two families are
    // account-level (see the doc comments on `loadTransitGatewayPlacement`/`loadS3BucketPlacement`)
    // and never go through the subnet-placement split below — they always land in
    // `accountResources`, drawn outside every VPC, regardless of whether AWS reports a subnet for
    // them (it never does).
    Promise.all([
      safely('Transit Gateway placement', loadTransitGatewayPlacement),
      safely('S3 bucket placement', loadS3BucketPlacement),
    ]),
  ]);

  // Edges are best-effort for the same reason the families are: a permission gap or a throttle here must
  // cost the arrows, not the whole map.
  let edges: TopologyEdge[] = [];
  try {
    const ecsTargetGroups = await loadEcsTargetGroupMap();
    edges = (await loadLoadBalancerEdges(ecsTargetGroups)).edges;
  } catch (err) {
    logger.error('topology-collector: load balancer edges failed (map renders without arrows)', err);
  }

  // Egress edges come straight from the route tables already collected — no extra API call.
  for (const vpc of vpcs) {
    for (const subnet of vpc.subnets) {
      if (subnet.egressVia) {
        edges.push({ from: subnet.subnetId, to: subnet.egressVia.id, kind: 'egress-via' });
      }
    }
  }

  const knownSubnetIds = new Set(vpcs.flatMap((v) => v.subnets.map((s) => s.subnetId)));
  const knownVpcIds = new Set(vpcs.map((v) => v.vpcId));

  const accountResources = accountFamilies.flat();
  const knownTgwIds = new Set(accountResources.filter((r) => r.kind === 'tgw').map((r) => r.id));

  try {
    const vpcLevelTgwEdges = await loadTransitGatewayEdges(knownVpcIds, knownTgwIds);
    edges.push(...refineTransitGatewayEdgesWithSubnetEvidence(vpcLevelTgwEdges, vpcs));
  } catch (err) {
    logger.error('topology-collector: Transit Gateway attachments failed (map renders without TGW edges)', err);
  }

  const resources: TopologyResource[] = [];
  const unplacedResources: TopologyResource[] = [];
  for (const resource of families.flat()) {
    // Keep only the subnets that actually exist in the collected VPCs; a resource left with none is
    // reported as unplaced rather than dropped, so the map can say "these exist but I cannot place
    // them" instead of quietly presenting an incomplete picture as complete.
    const placeable = resource.subnetIds.filter((id) => knownSubnetIds.has(id));
    if (placeable.length > 0) resources.push({ ...resource, subnetIds: placeable });
    else unplacedResources.push(resource);
  }

  resources.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
  unplacedResources.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
  accountResources.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));

  // Drop any edge whose endpoints are not both on the map. An arrow to a node that is not drawn is worse
  // than no arrow: it reads as a dependency on something invisible.
  const drawableIds = new Set<string>([
    INTERNET_NODE_ID,
    ...resources.map((r) => r.id),
    ...knownSubnetIds,
    ...knownVpcIds,
    ...accountResources.map((r) => r.id),
  ]);
  // Deduplicated, because an edge is a RELATIONSHIP and AWS reports the same relationship more than
  // once. A load balancer with several target groups all registering the same instance yields one
  // `balances-to` per target group: on abc-prod (2026-09-08) `abc-smoketest-alb` reported the same
  // instance three times, and `abc-prod-alb` twice, inflating 20 real connections to 24.
  //
  // Collapsing them here rather than in the renderer matters because `edges.length` is a number the UI
  // shows the operator. Which target group the traffic passed through is not represented on the map at
  // all, so the duplicates carry no information — only a wrong count.
  const seenEdges = new Set<string>();
  const keptEdges = edges.filter((e) => {
    if (!drawableIds.has(e.from) || !drawableIds.has(e.to)) return false;
    const key = `${e.from}\u0000${e.to}\u0000${e.kind}`;
    if (seenEdges.has(key)) return false;
    seenEdges.add(key);
    return true;
  });

  const tierCounts = vpcs
    .flatMap((v) => v.subnets)
    .reduce<Record<string, number>>((acc, s) => ({ ...acc, [s.tier]: (acc[s.tier] ?? 0) + 1 }), {});

  logger.info(
    `topology-collector: ${vpcs.length} VPCs, ${knownSubnetIds.size} subnets ` +
      `(${JSON.stringify(tierCounts)}), ${resources.length} placed resources, ` +
      `${unplacedResources.length} unplaced, ${accountResources.length} account-level ` +
      `(${accountResources.filter((r) => r.kind === 'tgw').length} TGW, ` +
      `${accountResources.filter((r) => r.kind === 's3').length} S3), ` +
      `${keptEdges.length}/${edges.length} edges kept.`,
  );

  return {
    region: AWS_REGION,
    // Read at CALL time, not module scope: `collectTopology()` is called from two different
    // Lambdas — `get-topology.ts` (inside the router, which already validates the full
    // `AppConfig` via `config.ts`) AND `infra-collector.ts` (a standalone scheduled Lambda that
    // does not import `config.ts`, and is granted only the env vars its own S3-cache-writing job
    // needs). Reading it directly here — rather than importing `config.ts`, or capturing it in a
    // module-level const at import time — avoids two different failure modes: pulling in
    // `config.ts` would make `infra-collector.ts`'s module initializer throw the moment it is
    // missing an unrelated var like `ENTRA_TENANT_ID` (the exact failure documented on
    // `ASSESSMENT_BUCKET_NAME` above `InfraCollectorFunction` in `infra/ops-dashboard.yaml` — 288
    // failed invocations/day for 10 days before anyone noticed); a module-level const would freeze
    // whatever the variable held at cold start, which is invisible in a Lambda but breaks any test
    // that sets the env var after this module is first imported. Left `undefined` rather than
    // throwing when absent: this field only labels the account frame on the map, and a map should
    // not go dark over a cosmetic label.
    accountId: process.env.AWS_ACCOUNT_ID,
    vpcs,
    edges: keptEdges,
    resources,
    unplacedResources,
    accountResources,
    generatedAt: new Date().toISOString(),
  };
}
