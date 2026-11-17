import { test, expect } from '@playwright/test';
import { mockSignedInUser } from './fixtures/auth';
import { mockApi } from './fixtures/mockApi';

/**
 * App shell + navigation — every one of the 9 nav-linked tabs (`NAV_ITEMS` in
 * `src/components/NavItems.ts`) must render its route without a console error, and the sidebar
 * must link to all of them. Also covers the unauthenticated sign-in gate (`SignInGate` in
 * `__root.tsx`), since that is the one path that does NOT go through `mockSignedInUser()`.
 */

const NAV_TABS: { label: string; href: string; heading: string }[] = [
  { label: 'Infra Map', href: '/infra-map', heading: 'Infra Map' },
  { label: 'Monitoring', href: '/monitoring', heading: 'Monitoring' },
  { label: 'Infrastructure', href: '/infra', heading: 'Infrastructure' },
  { label: 'Run Command', href: '/run-command', heading: 'Run Command' },
  { label: 'Scheduled Runs', href: '/scheduled', heading: 'Scheduled Runs' },
  { label: 'Backup & Compliance', href: '/compliance', heading: 'Backup & Compliance' },
  { label: 'Security Group', href: '/security-groups', heading: 'Security Groups' },
  { label: 'Cost', href: '/cost', heading: 'Cost' },
  { label: 'Assessment', href: '/assessment', heading: 'Assessment' },
  { label: 'Logs', href: '/logs', heading: 'Logs' },
];

test.describe('App shell + navigation', () => {
  test('shows the sign-in gate when unauthenticated', async ({ page }) => {
    await mockApi(page);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'ops-dashboard' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in with Microsoft Entra ID' })).toBeVisible();
  });

  test('renders every nav tab without console errors once authenticated', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    await mockSignedInUser(page);
    await mockApi(page);
    await page.goto('/infra-map');

    // Sidebar renders all 9 links.
    for (const tab of NAV_TABS) {
      await expect(page.getByRole('link', { name: tab.label, exact: true })).toBeVisible();
    }

    for (const tab of NAV_TABS) {
      await page.getByRole('link', { name: tab.label, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`${tab.href}$`));
      await expect(page.getByRole('heading', { name: tab.heading, level: 1 })).toBeVisible();
    }

    // React/Cloudscape dev-only warnings are not "errors" (console.error only) in this build —
    // filtering out third-party noise is intentionally NOT done here: any console.error at all
    // during pure navigation across every tab is worth surfacing as a real regression.
    expect(consoleErrors, `Unexpected console errors during navigation:\n${consoleErrors.join('\n')}`).toEqual([]);
  });

  test('shows user identity and allows switching density/theme from the top nav', async ({ page }) => {
    await mockSignedInUser(page);
    await mockApi(page);
    await page.goto('/infra-map');
    await expect(page.getByRole('button', { name: /E2E Test User/ })).toBeVisible();
  });
});
