import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ActionPreview } from '@ops-dashboard/shared';
import { ConfirmationDialog } from './ConfirmationDialog';

function basePreview(overrides: Partial<ActionPreview> = {}): ActionPreview {
  return {
    actionType: 'EC2_Stop',
    awsApiCall: 'StateManager: POST /instances/{region}/{id}/stop',
    resource: { id: 'i-0123456789abcdef0', arn: 'arn:aws:ec2:ap-southeast-1:123456789012:instance/i-0123456789abcdef0', region: 'ap-southeast-1' },
    params: { instanceId: 'i-0123456789abcdef0' },
    reversibilityClass: 'reversible',
    ...overrides,
  };
}

function baseProps(overrides: Partial<Parameters<typeof ConfirmationDialog>[0]> = {}) {
  return {
    visible: true,
    onDismiss: vi.fn(),
    title: 'Stop i-0123456789abcdef0',
    preview: basePreview(),
    previewLoading: false,
    previewError: undefined,
    executing: false,
    executeError: undefined,
    result: undefined,
    onConfirm: vi.fn(),
    ...overrides,
  };
}

describe('ConfirmationDialog', () => {
  it('passes visible=false through to Cloudscape Modal, which marks the dialog hidden rather than unmounting it', () => {
    render(<ConfirmationDialog {...baseProps({ visible: false })} />);
    // Cloudscape's Modal keeps the dialog in the DOM and toggles a CSS class (not the native
    // `hidden` attribute) — so it's still queryable by role, just visually hidden. Assert on
    // that class instead of DOM presence, which would give a false negative either way.
    const dialog = screen.getByRole('dialog');
    expect(dialog.className).toMatch(/hidden/);
  });

  it('shows a loading spinner while the preview is loading', () => {
    render(<ConfirmationDialog {...baseProps({ preview: undefined, previewLoading: true })} />);
    expect(screen.getByText(/Loading live preview/)).toBeInTheDocument();
  });

  it('shows the preview error and does not render preview details', () => {
    render(<ConfirmationDialog {...baseProps({ preview: undefined, previewError: 'Instance not found' })} />);
    expect(screen.getByText('Instance not found')).toBeInTheDocument();
  });

  it('renders the AWS API call, resource id, region, and reversibility for a reversible action', () => {
    render(<ConfirmationDialog {...baseProps()} />);
    expect(screen.getByText('StateManager: POST /instances/{region}/{id}/stop')).toBeInTheDocument();
    // The resource id appears twice (the KeyValuePairs "Resource" row AND the raw params dump,
    // since `params.instanceId` echoes the same id) — assert at least one match rather than a
    // single unique node.
    expect(screen.getAllByText('i-0123456789abcdef0').length).toBeGreaterThan(0);
    expect(screen.getByText('ap-southeast-1')).toBeInTheDocument();
    expect(screen.getByText('reversible')).toBeInTheDocument();
  });

  it('enables Confirm immediately for a reversible action with no security warning', () => {
    render(<ConfirmationDialog {...baseProps()} />);
    expect(screen.getByRole('button', { name: 'Confirm' })).not.toBeDisabled();
  });

  it('disables Confirm for an irreversible action until the resource id is typed exactly', () => {
    const preview = basePreview({ reversibilityClass: 'irreversible', actionType: 'ElasticIp_Release' });
    render(<ConfirmationDialog {...baseProps({ preview })} />);

    expect(screen.getByText('This action cannot be undone')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeDisabled();

    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'i-0123456789abcdef0' } });
    expect(screen.getByRole('button', { name: 'Confirm' })).not.toBeDisabled();
  });

  it('disables Confirm for a reversible action WITH a security warning until typed, and shows the warning above cost warning', () => {
    const preview = basePreview({
      actionType: 'SecurityGroup_AuthorizeIngress',
      reversibilityClass: 'reversible',
      securityImpactWarning: 'CRITICAL SECURITY WARNING: opens SSH to the world.',
      costImpactWarning: 'This action may affect operating cost.',
    });
    render(<ConfirmationDialog {...baseProps({ preview })} />);

    const securityAlert = screen.getByText(/CRITICAL SECURITY WARNING/);
    const costAlert = screen.getByText(/may affect operating cost/);
    expect(securityAlert.compareDocumentPosition(costAlert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeDisabled();

    fireEvent.change(screen.getByRole('textbox'), { target: { value: preview.resource.id } });
    expect(screen.getByRole('button', { name: 'Confirm' })).not.toBeDisabled();
  });

  it('calls onConfirm when Confirm is clicked and enabled', () => {
    const onConfirm = vi.fn();
    render(<ConfirmationDialog {...baseProps({ onConfirm })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('shows the execute error when execution fails', () => {
    render(<ConfirmationDialog {...baseProps({ executeError: 'action-execution-fn threw an unhandled error' })} />);
    expect(screen.getByText('action-execution-fn threw an unhandled error')).toBeInTheDocument();
  });

  it('shows the outcome alert and swaps Confirm for Close once a result exists', () => {
    render(<ConfirmationDialog {...baseProps({ result: { outcome: 'success' } })} />);
    expect(screen.getByText('Outcome: success')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });

  it('shows a warning-toned outcome for a partial result and error-toned for failure/rejected', () => {
    const { rerender } = render(<ConfirmationDialog {...baseProps({ result: { outcome: 'partial', reason: 'some tags failed' } })} />);
    expect(screen.getByText('some tags failed')).toBeInTheDocument();

    rerender(<ConfirmationDialog {...baseProps({ result: { outcome: 'failure', reason: 'boom' } })} />);
    expect(screen.getByText('boom')).toBeInTheDocument();
  });

  it('disables Confirm while executing', () => {
    render(<ConfirmationDialog {...baseProps({ executing: true })} />);
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeDisabled();
  });
});
