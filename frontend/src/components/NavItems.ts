import type { SideNavigationProps } from '@cloudscape-design/components/side-navigation';

/**
 * Route paths for every tab — the single source of truth for both `SideNavigation`'s `items` and
 * the TanStack Router route tree under `src/routes/`. A route file's path segment MUST match the
 * `href` here exactly (TanStack Router is file-based, so this is enforced by the file layout
 * itself, not by this list — this list exists so the sidebar and the command palette read from
 * one place instead of duplicating route strings).
 *
 * Cloudscape's `Section` item REQUIRES a nested `items` array (it is not a bare heading followed
 * by flat links) — each group below nests its links inside its own `Section.items`.
 */
export const NAV_ITEMS: SideNavigationProps.Item[] = [
  {
    type: 'section',
    text: 'Overview',
    defaultExpanded: true,
    items: [
      { type: 'link', text: 'Infra Map', href: '/infra-map' },
      { type: 'link', text: 'Monitoring', href: '/monitoring' },
    ],
  },
  {
    type: 'section',
    text: 'Operate',
    defaultExpanded: true,
    items: [
      { type: 'link', text: 'Infrastructure', href: '/infra' },
      { type: 'link', text: 'Run Command', href: '/run-command' },
      { type: 'link', text: 'Scheduled Runs', href: '/scheduled' },
    ],
  },
  {
    type: 'section',
    text: 'Govern',
    defaultExpanded: true,
    items: [
      { type: 'link', text: 'Backup & Compliance', href: '/compliance' },
      { type: 'link', text: 'Security Group', href: '/security-groups' },
      { type: 'link', text: 'Approvals', href: '/approvals' },
      { type: 'link', text: 'Playbooks', href: '/playbooks' },
    ],
  },
  {
    type: 'section',
    text: 'Analyse',
    defaultExpanded: true,
    items: [
      { type: 'link', text: 'Cost', href: '/cost' },
      { type: 'link', text: 'Assessment', href: '/assessment' },
      { type: 'link', text: 'Logs', href: '/logs' },
    ],
  },
];

/** Flat (href, label) pairs — used by the command palette (Cmd/Ctrl+K) so it can list every
 * navigable page without walking the section structure `NAV_ITEMS` needs for rendering. */
export const NAV_LINKS: { href: string; label: string }[] = NAV_ITEMS.flatMap((item) =>
  item.type === 'section' ? item.items.filter((child): child is SideNavigationProps.Link => child.type === 'link') : [],
).map((item) => ({ href: item.href, label: item.text }));
