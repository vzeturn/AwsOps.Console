import { describe, it, expect } from 'vitest';
import { NAV_ITEMS, NAV_LINKS } from './NavItems';

describe('NAV_ITEMS', () => {
  it('every section carries a non-empty items array (Cloudscape SideNavigationProps.Section requirement)', () => {
    for (const item of NAV_ITEMS) {
      expect(item.type).toBe('section');
      if (item.type === 'section') {
        expect(item.items.length).toBeGreaterThan(0);
      }
    }
  });

  it('every href starts with "/" and has no trailing slash — must match a route file path exactly', () => {
    for (const item of NAV_ITEMS) {
      if (item.type !== 'section') continue;
      for (const child of item.items) {
        if (child.type !== 'link') continue;
        expect(child.href.startsWith('/')).toBe(true);
        expect(child.href.endsWith('/')).toBe(false);
      }
    }
  });

  it('has no duplicate href across the whole nav (each route reachable exactly one way from the sidebar)', () => {
    const hrefs = NAV_ITEMS.flatMap((item) => (item.type === 'section' ? item.items : []))
      .filter((child): child is { type: 'link'; href: string; text: string } => child.type === 'link')
      .map((child) => child.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });
});

describe('NAV_LINKS', () => {
  it('flattens exactly the links nested under every NAV_ITEMS section, in the same order', () => {
    const expected = NAV_ITEMS.flatMap((item) =>
      item.type === 'section' ? item.items.filter((child) => child.type === 'link') : [],
    ).map((link) => ({ href: (link as { href: string }).href, label: (link as { text: string }).text }));
    expect(NAV_LINKS).toEqual(expected);
  });

  it('every link has both a non-empty href and label — the command palette renders label and navigates by href', () => {
    for (const link of NAV_LINKS) {
      expect(link.href.length).toBeGreaterThan(0);
      expect(link.label.length).toBeGreaterThan(0);
    }
  });
});
