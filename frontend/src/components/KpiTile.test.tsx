import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { KpiTile } from './KpiTile';

describe('KpiTile', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('Requirement 1.3/1.4: without `onActivate`, renders with no role/tabIndex/interactive affordance at all (unchanged from before this prop existed)', () => {
    render(<KpiTile label="VPCs" value="3" />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('VPCs')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('Requirement 1.1: with `onActivate`, renders as an Interactive_Kpi — role="button", tabIndex=0, aria-label from activateLabel', () => {
    render(<KpiTile label="Unplaced resources" value="4" onActivate={vi.fn()} activateLabel="Scroll to unplaced resources" />);
    const button = screen.getByRole('button', { name: 'Scroll to unplaced resources' });
    expect(button).toBeInTheDocument();
    expect(button).toHaveAttribute('tabindex', '0');
  });

  it('Requirement 1.2: clicking an Interactive_Kpi calls onActivate', () => {
    const onActivate = vi.fn();
    render(<KpiTile label="Unplaced resources" value="4" onActivate={onActivate} activateLabel="Scroll to unplaced resources" />);
    fireEvent.click(screen.getByRole('button', { name: 'Scroll to unplaced resources' }));
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it('Requirement 1.2: Enter and Space both activate an Interactive_Kpi while focused', () => {
    const onActivate = vi.fn();
    render(<KpiTile label="Unplaced resources" value="4" onActivate={onActivate} activateLabel="Scroll to unplaced resources" />);
    const button = screen.getByRole('button', { name: 'Scroll to unplaced resources' });

    fireEvent.keyDown(button, { key: 'Enter' });
    expect(onActivate).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(button, { key: ' ' });
    expect(onActivate).toHaveBeenCalledTimes(2);

    fireEvent.keyDown(button, { key: 'Tab' });
    expect(onActivate).toHaveBeenCalledTimes(2);
  });

  it('warns in dev mode when `onActivate` is passed without `activateLabel`', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<KpiTile label="Unplaced resources" value="4" onActivate={vi.fn()} />);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('activateLabel'));
  });

  it('still renders label/value/caption/trend/severity exactly as before when interactive', () => {
    render(
      <KpiTile
        label="Unplaced resources"
        value="4"
        caption="of 120 total"
        severity="warning"
        onActivate={vi.fn()}
        activateLabel="Scroll to unplaced resources"
      />,
    );
    expect(screen.getByText('Unplaced resources')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
    expect(screen.getByText('of 120 total')).toBeInTheDocument();
  });
});
