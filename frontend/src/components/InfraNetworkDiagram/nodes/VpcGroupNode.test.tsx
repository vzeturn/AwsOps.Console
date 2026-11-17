import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { TopologyVpc } from '@ops-dashboard/shared';
import type { NodeProps } from '@xyflow/react';
import { VpcGroupNode } from './VpcGroupNode';

function buildVpc(overrides: Partial<TopologyVpc> = {}): TopologyVpc {
  return { vpcId: 'vpc-1', name: 'main', cidrBlock: '10.0.0.0/16', isDefault: false, subnets: [], ...overrides };
}

function buildNodeProps<T>(data: T): NodeProps & { data: T } {
  return { id: 'vpc-1', data, selected: false, type: 'vpcGroup', dragging: false, zIndex: 0, isConnectable: false, positionAbsoluteX: 0, positionAbsoluteY: 0, draggable: false, selectable: false, deletable: false, width: 260, height: 100 } as unknown as NodeProps & { data: T };
}

describe('VpcGroupNode', () => {
  it('shows the VPC name, CIDR block, and subnet count', () => {
    const vpc = buildVpc({ subnets: [{ subnetId: 's1', name: 'a', cidrBlock: '10.0.1.0/24', availabilityZone: 'ap-southeast-1a', tier: 'public', isPublic: true, availableIpCount: 250 }] });
    render(<VpcGroupNode {...buildNodeProps({ vpc })} />);
    expect(screen.getByText('main')).toBeInTheDocument();
    expect(screen.getByText('10.0.0.0/16 · 1 subnets')).toBeInTheDocument();
  });

  it('falls back to the vpcId when name is empty', () => {
    const vpc = buildVpc({ name: '' });
    render(<VpcGroupNode {...buildNodeProps({ vpc })} />);
    expect(screen.getByText('vpc-1')).toBeInTheDocument();
  });

  it('shows a "default" badge for the default VPC', () => {
    const vpc = buildVpc({ isDefault: true });
    render(<VpcGroupNode {...buildNodeProps({ vpc })} />);
    expect(screen.getByText('default')).toBeInTheDocument();
  });

  it('shows no "default" badge for a non-default VPC', () => {
    const vpc = buildVpc({ isDefault: false });
    render(<VpcGroupNode {...buildNodeProps({ vpc })} />);
    expect(screen.queryByText('default')).toBeNull();
  });
});
