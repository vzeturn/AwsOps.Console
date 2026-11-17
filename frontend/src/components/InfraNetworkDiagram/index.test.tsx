import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { Node, Edge } from '@xyflow/react';
import type { TopologyData, TopologyResource, TopologySubnet, TopologyVpc } from '@ops-dashboard/shared';
import type { VpcLayoutInput } from './elkLayoutAdapter';
import { InfraNetworkDiagram } from './index';

/**
 * `computeVpcLayout` runs the REAL `elkjs` layout algorithm through a real (or Worker-backed)
 * `elk-api` instance — already covered end-to-end, against the real algorithm, by
 * `elkLayoutAdapter.test.ts`'s own 8 tests. Mocked here with a synchronous, deterministic stand-in
 * so THIS file can focus on what `InfraNetworkDiagram`/`index.tsx` is actually responsible for —
 * composition and wiring (Tabs-per-VPC, empty state, account-level/unplaced sections, passing the
 * right props down) — without depending on a real browser `Worker` (which jsdom does not
 * implement) or elkjs's own async layout timing.
 */
vi.mock('./elkLayoutAdapter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./elkLayoutAdapter')>();
  return {
    ...actual,
    computeVpcLayout: (input: VpcLayoutInput) => {
      const nodes: Node[] = [{ id: input.vpc.vpcId, type: 'vpcGroup', position: { x: 0, y: 0 }, data: { vpc: input.vpc } }];
      for (const subnet of input.vpc.subnets) {
        nodes.push({ id: `subnet:${subnet.subnetId}`, type: 'subnetGroup', position: { x: 0, y: 0 }, data: { subnet } });
        for (const resource of input.resourcesBySubnet.get(subnet.subnetId) ?? []) {
          nodes.push({ id: resource.id, type: 'resource', position: { x: 0, y: 0 }, data: { resource } });
        }
      }
      const edges: Edge[] = [];
      return Promise.resolve({ nodes, edges });
    },
  };
});

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

function buildVpc(overrides: Partial<TopologyVpc> = {}): TopologyVpc {
  return {
    vpcId: 'vpc-1',
    name: 'main',
    cidrBlock: '10.0.0.0/16',
    isDefault: false,
    subnets: [buildSubnet()],
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
    monitoringType: 'ec2',
    ...overrides,
  };
}

function buildData(overrides: Partial<TopologyData> = {}): TopologyData {
  return {
    region: 'ap-southeast-1',
    generatedAt: '2026-09-23T00:00:00.000Z',
    vpcs: [],
    edges: [],
    resources: [],
    unplacedResources: [],
    ...overrides,
  };
}

describe('InfraNetworkDiagram', () => {
  it('shows the empty state when there is no topology data at all', () => {
    render(<InfraNetworkDiagram data={buildData()} health={new Map()} onResourceClick={vi.fn()} />);
    expect(screen.getByText('No topology data yet.')).toBeInTheDocument();
  });

  it('renders a single VPC without a tab strip, and the legend before the canvas', async () => {
    const vpc = buildVpc();
    const resource = buildResource();
    const data = buildData({ vpcs: [vpc], resources: [resource] });

    render(<InfraNetworkDiagram data={data} health={new Map()} onResourceClick={vi.fn()} />);

    // No Tabs component (Cloudscape renders tab roles as "tab") when there's only one VPC.
    expect(screen.queryByRole('tab')).toBeNull();

    // Legend renders immediately (it's static, no async layout dependency).
    expect(screen.getByText('Balances to')).toBeInTheDocument();

    // The ELK layout is async — the resource node only appears once `computeVpcLayout` resolves.
    await waitFor(() => expect(screen.getByText('i-abc123')).toBeInTheDocument());
  });

  it('renders one Tab per VPC when there are 2+ VPCs, labeled with each VPC\'s own resource count', async () => {
    const vpcA = buildVpc({ vpcId: 'vpc-a', name: 'vpc-a', subnets: [buildSubnet({ subnetId: 'subnet-a' })] });
    const vpcB = buildVpc({ vpcId: 'vpc-b', name: 'vpc-b', subnets: [buildSubnet({ subnetId: 'subnet-b' })] });
    const resourceA = buildResource({ id: 'i-a', name: 'i-a', subnetIds: ['subnet-a'] });
    const data = buildData({ vpcs: [vpcA, vpcB], resources: [resourceA] });

    render(<InfraNetworkDiagram data={data} health={new Map()} onResourceClick={vi.fn()} />);

    expect(screen.getByRole('tab', { name: 'vpc-a (1)' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'vpc-b (0)' })).toBeInTheDocument();

    // The active tab's VpcDiagramCanvas still kicks off its own async (mocked) layout effect —
    // waited out here so the assertions above are not left racing a pending state update
    // (React's "not wrapped in act(...)" warning otherwise, since `computeVpcLayout`'s mock is
    // still an async microtask even though it never touches a real Worker).
    await waitFor(() => expect(screen.getByText('i-a')).toBeInTheDocument());
  });

  it('renders the "Unplaced resources" section with the scroll-target id when there are unplaced resources', () => {
    const unplaced = buildResource({ id: 'orphan-1', name: 'orphan-1' });
    const data = buildData({ unplacedResources: [unplaced] });

    const { container } = render(<InfraNetworkDiagram data={data} health={new Map()} onResourceClick={vi.fn()} />);

    expect(container.querySelector('#infra-map-unplaced-section')).not.toBeNull();
    expect(screen.getByText('Unplaced resources')).toBeInTheDocument();
    expect(screen.getByText('orphan-1')).toBeInTheDocument();
  });

  it('renders the "Account-level resources" section for S3/TGW resources', () => {
    const bucket = buildResource({ id: 'bucket-1', kind: 's3', name: 'bucket-1', monitoringType: undefined });
    const data = buildData({ accountResources: [bucket] });

    render(<InfraNetworkDiagram data={data} health={new Map()} onResourceClick={vi.fn()} />);

    expect(screen.getByText('Account-level resources')).toBeInTheDocument();
    expect(screen.getByText('bucket-1')).toBeInTheDocument();
  });
});
