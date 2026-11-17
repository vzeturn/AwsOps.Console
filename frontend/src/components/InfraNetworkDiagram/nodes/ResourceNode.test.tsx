import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { TopologyResource } from '@ops-dashboard/shared';
import { ResourceNode } from './ResourceNode';
import type { NodeProps } from '@xyflow/react';

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

/** Minimal NodeProps stub — this component only reads `data`, so every other React-Flow-injected
 * field is irrelevant to what's under test (matches the "mock only what's needed" convention
 * already used elsewhere in this codebase, e.g. `assessment.test.tsx`'s `buildEvent`). Generic
 * over `T` so the caller's exact `data` shape survives into the returned props (a non-generic
 * `unknown` parameter widens `data` to `unknown` and breaks the component's own `{ data:
 * ResourceNodeData }` type requirement at the call site). */
function buildNodeProps<T>(data: T): NodeProps & { data: T } {
  return { id: 'n1', data, selected: false, type: 'resource', dragging: false, zIndex: 0, isConnectable: false, positionAbsoluteX: 0, positionAbsoluteY: 0, draggable: false, selectable: false, deletable: false, width: 150, height: 56 } as unknown as NodeProps & { data: T };
}

describe('ResourceNode', () => {
  it('a resource WITH a monitoringType is clickable: role=button, cursor pointer, calls onResourceClick on click', () => {
    const onResourceClick = vi.fn();
    const resource = buildResource();
    render(<ResourceNode {...buildNodeProps({ resource, threshold: undefined, onResourceClick })} />);

    const chip = screen.getByRole('button', { name: `Open ${resource.name} details` });
    expect(chip).toBeInTheDocument();
    fireEvent.click(chip);
    expect(onResourceClick).toHaveBeenCalledWith(resource);
  });

  it('Enter key activates the same as a click', () => {
    const onResourceClick = vi.fn();
    const resource = buildResource();
    render(<ResourceNode {...buildNodeProps({ resource, threshold: undefined, onResourceClick })} />);

    fireEvent.keyDown(screen.getByRole('button'), { key: 'Enter' });
    expect(onResourceClick).toHaveBeenCalledWith(resource);
  });

  it('a resource WITHOUT a monitoringType (e.g. NAT gateway) is NOT clickable: no role, no tabIndex, static dimmed opacity', () => {
    const onResourceClick = vi.fn();
    const resource = buildResource({ kind: 'natgw', monitoringType: undefined });
    render(<ResourceNode {...buildNodeProps({ resource, threshold: undefined, onResourceClick })} />);

    expect(screen.queryByRole('button')).toBeNull();
    const chip = screen.getByText(resource.name).closest('[data-clickable]');
    expect(chip).toHaveAttribute('data-clickable', 'false');
    expect(chip).toHaveStyle({ opacity: '0.75' });
  });

  it('a clickable resource has full opacity (no static dimming)', () => {
    const resource = buildResource();
    render(<ResourceNode {...buildNodeProps({ resource, threshold: undefined, onResourceClick: vi.fn() })} />);
    const chip = screen.getByRole('button');
    expect(chip).toHaveStyle({ opacity: '1' });
  });

  it("shows the resource's full name in the title attribute even when visually truncated", () => {
    const resource = buildResource({ name: 'i-0a1b2c3d4e5f60001-a-very-long-name' });
    render(<ResourceNode {...buildNodeProps({ resource, threshold: undefined, onResourceClick: vi.fn() })} />);
    expect(screen.getByTitle(resource.name)).toBeInTheDocument();
  });

  it('shows "unmonitored" status when no threshold is provided', () => {
    const resource = buildResource();
    render(<ResourceNode {...buildNodeProps({ resource, threshold: undefined, onResourceClick: vi.fn() })} />);
    expect(screen.getByText('unmonitored')).toBeInTheDocument();
  });

  it('shows the threshold level when provided', () => {
    const resource = buildResource();
    const threshold = { level: 'critical' as const, reason: 'CPU high' };
    render(<ResourceNode {...buildNodeProps({ resource, threshold, onResourceClick: vi.fn() })} />);
    expect(screen.getByText('critical')).toBeInTheDocument();
  });
});
