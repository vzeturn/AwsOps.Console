import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { TopologySubnet } from '@ops-dashboard/shared';
import type { NodeProps } from '@xyflow/react';
import { SubnetGroupNode } from './SubnetGroupNode';

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

function buildNodeProps<T>(data: T): NodeProps & { data: T } {
  return { id: 'subnet:subnet-1', data, selected: false, type: 'subnetGroup', dragging: false, zIndex: 0, isConnectable: false, positionAbsoluteX: 0, positionAbsoluteY: 0, draggable: false, selectable: false, deletable: false, width: 220, height: 90 } as unknown as NodeProps & { data: T };
}

describe('SubnetGroupNode', () => {
  it('shows the subnet name, tier badge, and CIDR/AZ/IP-count line', () => {
    const subnet = buildSubnet();
    render(<SubnetGroupNode {...buildNodeProps({ subnet })} />);
    expect(screen.getByText('public-a')).toBeInTheDocument();
    expect(screen.getByText('public')).toBeInTheDocument();
    expect(screen.getByText('10.0.1.0/24 · ap-southeast-1a · 250 IPs free')).toBeInTheDocument();
  });

  it.each(['public', 'private', 'isolated'] as const)('renders the %s tier badge', (tier) => {
    const subnet = buildSubnet({ tier });
    render(<SubnetGroupNode {...buildNodeProps({ subnet })} />);
    expect(screen.getByText(tier)).toBeInTheDocument();
  });

  it('falls back to the subnetId when name is empty', () => {
    const subnet = buildSubnet({ name: '' });
    render(<SubnetGroupNode {...buildNodeProps({ subnet })} />);
    expect(screen.getByText('subnet-1')).toBeInTheDocument();
  });
});
