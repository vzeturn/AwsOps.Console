import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { TopologyResource } from '@ops-dashboard/shared';
import { AccountResourceGroupBox } from './AccountResourceGroupBox';

function buildResource(overrides: Partial<TopologyResource> = {}): TopologyResource {
  return { id: 'bucket-1', kind: 's3', name: 'my-bucket', state: 'active', subnetIds: [], ...overrides };
}

describe('AccountResourceGroupBox', () => {
  it('renders the title, description, and every resource chip', () => {
    const resources = [buildResource(), buildResource({ id: 'bucket-2', name: 'other-bucket' })];
    render(
      <AccountResourceGroupBox
        title="Account-level resources"
        description="S3 buckets and Transit Gateways — not scoped to one VPC."
        resources={resources}
        health={new Map()}
        onResourceClick={vi.fn()}
        accentColor="#7d8998"
      />,
    );
    expect(screen.getByText('Account-level resources')).toBeInTheDocument();
    expect(screen.getByText('my-bucket')).toBeInTheDocument();
    expect(screen.getByText('other-bucket')).toBeInTheDocument();
  });

  it('applies the given `id` for scroll-target wiring (Requirement 1.2)', () => {
    const { container } = render(
      <AccountResourceGroupBox
        id="infra-map-unplaced-section"
        title="Unplaced resources"
        description="desc"
        resources={[]}
        health={new Map()}
        onResourceClick={vi.fn()}
        accentColor="#f59e0b"
        warning
      />,
    );
    expect(container.querySelector('#infra-map-unplaced-section')).not.toBeNull();
  });

  it('a resource with a monitoringType is clickable and calls onResourceClick', () => {
    const onResourceClick = vi.fn();
    const resource = buildResource({ kind: 'ec2', monitoringType: 'ec2' });
    render(
      <AccountResourceGroupBox
        title="t"
        description="d"
        resources={[resource]}
        health={new Map()}
        onResourceClick={onResourceClick}
        accentColor="#000"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: `Open ${resource.name} details` }));
    expect(onResourceClick).toHaveBeenCalledWith(resource);
  });

  it('an S3 bucket (no monitoringType) is not clickable', () => {
    const resource = buildResource();
    render(
      <AccountResourceGroupBox title="t" description="d" resources={[resource]} health={new Map()} onResourceClick={vi.fn()} accentColor="#000" />,
    );
    expect(screen.queryByRole('button')).toBeNull();
  });
});
