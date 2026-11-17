import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const navigateMock = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateMock,
}));

vi.mock('./NavItems', () => ({
  NAV_LINKS: [
    { href: '/infra-map', label: 'Infra Map' },
    { href: '/monitoring', label: 'Monitoring' },
  ],
}));

const { CommandPalette } = await import('./CommandPalette');

beforeEach(() => {
  navigateMock.mockClear();
});

describe('CommandPalette', () => {
  it('renders nothing until Cmd/Ctrl+K is pressed', () => {
    render(<CommandPalette />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens on Ctrl+K and lists every NAV_LINKS entry', () => {
    render(<CommandPalette />);
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true });

    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeInTheDocument();
    expect(screen.getByText('Infra Map')).toBeInTheDocument();
    expect(screen.getByText('Monitoring')).toBeInTheDocument();
  });

  it('opens on Cmd (meta)+K too — Mac convention', () => {
    render(<CommandPalette />);
    fireEvent.keyDown(document, { key: 'k', metaKey: true });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('toggles closed when Ctrl+K is pressed again while already open', () => {
    render(<CommandPalette />);
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes on Escape', () => {
    render(<CommandPalette />);
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('selecting a link navigates to its href and closes the palette', () => {
    render(<CommandPalette />);
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true });

    fireEvent.click(screen.getByText('Monitoring'));

    expect(navigateMock).toHaveBeenCalledWith({ to: '/monitoring' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('clicking the overlay (outside the dialog) closes the palette without navigating', () => {
    render(<CommandPalette />);
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true });

    fireEvent.click(screen.getByRole('presentation'));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(navigateMock).not.toHaveBeenCalled();
  });
});
