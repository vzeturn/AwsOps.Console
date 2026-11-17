import { describe, it, expect } from 'vitest';
// `elkjs`'s package MAIN entry (not `elkjs/lib/elk-api`, which `elkLayoutAdapter.ts` itself uses
// for production — see that file's own top-of-file comment for the full story) is used ONLY here,
// in the test file: its constructor's synchronous fallback works correctly under Vitest's jsdom
// environment (no real `Worker` global) without needing `workerUrl`/`workerFactory` at all, at the
// cost of bundling the ~1.5MB layout algorithm inline — a non-issue for a test file, which is
// never shipped, but the exact reason `elkLayoutAdapter.ts` itself does NOT import this entry.
import ELK from 'elkjs';
import type { TopologyEdge, TopologyResource, TopologySubnet, TopologyVpc } from '@ops-dashboard/shared';
import { INTERNET_NODE_ID } from '@ops-dashboard/shared';
import { computeVpcLayout, estimateResourceNodeWidth } from './elkLayoutAdapter';

const testElk = new ELK();

function buildSubnet(overrides: Partial<TopologySubnet> = {}): TopologySubnet {
  return {
    subnetId: 'subnet-1',
    name: 'public-a',
    cidrBlock: '10.0.1.0/24',
    availabilityZone: 'ap-southeast-1a',
    tier: 'public',
    isPublic: true,
    availableIpCount: 250,
    ...overrides,
  };
}

function buildVpc(subnets: TopologySubnet[], overrides: Partial<TopologyVpc> = {}): TopologyVpc {
  return {
    vpcId: 'vpc-1',
    name: 'main',
    cidrBlock: '10.0.0.0/16',
    isDefault: false,
    subnets,
    ...overrides,
  };
}

function buildResource(overrides: Partial<TopologyResource> = {}): TopologyResource {
  return {
    id: 'i-abc123',
    kind: 'ec2',
    name: 'i-abc123',
    state: 'running',
    subnetIds: ['subnet-1'],
    ...overrides,
  };
}

/** Axis-aligned bounding box overlap check, in each node's PARENT-RELATIVE coordinate space — only
 * meaningful for nodes sharing the same `parentId` (siblings), matching how ELK/React Flow express
 * nested positions (design.md's "no coordinate transformation needed" note). */
function boxesOverlap(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

describe('estimateResourceNodeWidth', () => {
  it('grows with name length within the min/max clamp', () => {
    const short = estimateResourceNodeWidth('nat-1');
    const long = estimateResourceNodeWidth('i-0a1b2c3d4e5f60001');
    expect(short).toBeGreaterThanOrEqual(150);
    expect(long).toBeGreaterThan(short);
    expect(long).toBeLessThanOrEqual(260);
  });

  it('clamps a pathologically long name at the max width rather than growing unboundedly', () => {
    const width = estimateResourceNodeWidth('a'.repeat(500));
    expect(width).toBe(260);
  });
});

describe('computeVpcLayout', () => {
  it('single VPC / single subnet / single resource: places the resource inside the subnet, the subnet inside the VPC', async () => {
    const subnet = buildSubnet();
    const resource = buildResource();
    const vpc = buildVpc([subnet]);
    const resourcesBySubnet = new Map([[subnet.subnetId, [resource]]]);

    const { nodes, edges } = await computeVpcLayout({ vpc, resourcesBySubnet, edges: [] }, testElk);

    const vpcNode = nodes.find((n) => n.id === vpc.vpcId);
    const subnetNode = nodes.find((n) => n.id === `subnet:${subnet.subnetId}`);
    const resourceNode = nodes.find((n) => n.id === resource.id);

    expect(vpcNode).toBeDefined();
    expect(vpcNode?.type).toBe('vpcGroup');
    expect(subnetNode).toBeDefined();
    expect(subnetNode?.type).toBe('subnetGroup');
    expect(subnetNode?.parentId).toBe(vpc.vpcId);
    expect(resourceNode).toBeDefined();
    expect(resourceNode?.type).toBe('resource');
    expect(resourceNode?.parentId).toBe(`subnet:${subnet.subnetId}`);
    expect(edges).toHaveLength(0);
  });

  it('VPC with 0 subnets: returns just the VPC + internet nodes, no error', async () => {
    const vpc = buildVpc([]);
    const { nodes, edges } = await computeVpcLayout({ vpc, resourcesBySubnet: new Map(), edges: [] }, testElk);

    expect(nodes.find((n) => n.id === vpc.vpcId)).toBeDefined();
    expect(nodes.find((n) => n.id === INTERNET_NODE_ID)).toBeDefined();
    expect(nodes).toHaveLength(2);
    expect(edges).toHaveLength(0);
  });

  it('a resource inside a subnet with an edge to a node OUTSIDE the subnet (the Dagre-bug-triggering shape) still places the resource inside its subnet, and the edge is included', async () => {
    const subnet = buildSubnet();
    const resource = buildResource({ id: 'alb-1', kind: 'alb', name: 'alb-1' });
    const vpc = buildVpc([subnet]);
    const resourcesBySubnet = new Map([[subnet.subnetId, [resource]]]);
    const edges: TopologyEdge[] = [{ from: INTERNET_NODE_ID, to: 'alb-1', kind: 'ingress-from' }];

    const { nodes, edges: rfEdges } = await computeVpcLayout({ vpc, resourcesBySubnet, edges }, testElk);

    const resourceNode = nodes.find((n) => n.id === 'alb-1');
    expect(resourceNode?.parentId).toBe(`subnet:${subnet.subnetId}`);
    expect(rfEdges).toHaveLength(1);
    expect(rfEdges[0]).toMatchObject({ source: INTERNET_NODE_ID, target: 'alb-1' });
  });

  it('an edge whose target is NOT in this VPC (e.g. the inactive Tabs pane) is excluded, not drawn dangling', async () => {
    const subnet = buildSubnet();
    const resource = buildResource();
    const vpc = buildVpc([subnet]);
    const resourcesBySubnet = new Map([[subnet.subnetId, [resource]]]);
    const edges: TopologyEdge[] = [{ from: resource.id, to: 'i-not-in-this-vpc', kind: 'balances-to' }];

    const { edges: rfEdges } = await computeVpcLayout({ vpc, resourcesBySubnet, edges }, testElk);

    expect(rfEdges).toHaveLength(0);
  });

  it('two subnets in the same tier get non-overlapping bounding boxes', async () => {
    const subnetA = buildSubnet({ subnetId: 'subnet-a', name: 'public-a' });
    const subnetB = buildSubnet({ subnetId: 'subnet-b', name: 'public-b', availabilityZone: 'ap-southeast-1b' });
    const vpc = buildVpc([subnetA, subnetB]);
    const resourcesBySubnet = new Map([
      [subnetA.subnetId, [buildResource({ id: 'i-a', name: 'i-a', subnetIds: ['subnet-a'] })]],
      [subnetB.subnetId, [buildResource({ id: 'i-b', name: 'i-b', subnetIds: ['subnet-b'] })]],
    ]);

    const { nodes } = await computeVpcLayout({ vpc, resourcesBySubnet, edges: [] }, testElk);

    const nodeA = nodes.find((n) => n.id === `subnet:${subnetA.subnetId}`)!;
    const nodeB = nodes.find((n) => n.id === `subnet:${subnetB.subnetId}`)!;
    const boxA = {
      x: nodeA.position.x,
      y: nodeA.position.y,
      width: (nodeA.style as { width: number }).width,
      height: (nodeA.style as { height: number }).height,
    };
    const boxB = {
      x: nodeB.position.x,
      y: nodeB.position.y,
      width: (nodeB.style as { width: number }).width,
      height: (nodeB.style as { height: number }).height,
    };
    expect(boxesOverlap(boxA, boxB)).toBe(false);
  });

  it('every resource node carries its TopologyResource in `data` for the custom node component to render', async () => {
    const subnet = buildSubnet();
    const resource = buildResource({ name: 'my-instance' });
    const vpc = buildVpc([subnet]);
    const resourcesBySubnet = new Map([[subnet.subnetId, [resource]]]);

    const { nodes } = await computeVpcLayout({ vpc, resourcesBySubnet, edges: [] }, testElk);

    const resourceNode = nodes.find((n) => n.id === resource.id);
    expect(resourceNode?.data).toMatchObject({ resource: { id: resource.id, name: 'my-instance' } });
  });
});
