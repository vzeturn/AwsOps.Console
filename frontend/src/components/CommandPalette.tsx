import { useEffect, useState, type MouseEvent } from 'react';
import { Command } from 'cmdk';
import { useNavigate } from '@tanstack/react-router';
import { NAV_LINKS } from './NavItems';

/**
 * Cmd/Ctrl+K quick-navigation — the one pattern every modern ops console this rebuild studied
 * (Datadog's DRUIDS design system, Vercel's dashboard, GitHub) uses as its primary "get anywhere
 * fast" mechanism. `cmdk` is the same headless primitive most of them are built on; styling here
 * is deliberately minimal (Cloudscape has no first-party command-palette component to build on
 * top of), so this is one of the few places in the app NOT using a Cloudscape component directly.
 */
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((value) => !value);
      }
      if (event.key === 'Escape') {
        setOpen(false);
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  if (!open) return null;

  return (
    <div
      className="command-palette-overlay"
      role="presentation"
      onClick={() => setOpen(false)}
    >
      <Command
        className="command-palette"
        role="dialog"
        aria-label="Command palette"
        onClick={(event: MouseEvent) => event.stopPropagation()}
      >
        {/* eslint-disable-next-line jsx-a11y/no-autofocus -- deliberate: this input only exists
            after the user just pressed Cmd/Ctrl+K, a keyboard shortcut whose entire point is to
            jump straight into typing a filter query. Not landing focus here (the a11y rule's usual
            worry: autofocus stealing focus from unrelated page content on load) does not apply —
            the palette is a modal opened BY keyboard action, so focus was already keyboard-driven. */}
        <Command.Input autoFocus placeholder="Jump to a page..." className="command-palette-input" />
        <Command.List className="command-palette-list">
          <Command.Empty className="command-palette-empty">No matching page.</Command.Empty>
          {NAV_LINKS.map((link) => (
            <Command.Item
              key={link.href}
              value={link.label}
              className="command-palette-item"
              onSelect={() => {
                setOpen(false);
                void navigate({ to: link.href });
              }}
            >
              {link.label}
            </Command.Item>
          ))}
        </Command.List>
      </Command>
    </div>
  );
}
