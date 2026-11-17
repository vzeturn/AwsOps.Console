import { defineConfig, devices } from '@playwright/test';

/**
 * E2E suite for the ops-dashboard SPA. Runs against a local `vite preview` server (the actual
 * production build, not `vite dev`) with authentication and every backend API call mocked via
 * Playwright route interception (see `e2e/fixtures/`) — no real AWS credentials, no real Entra ID
 * sign-in, and no network calls leave the machine.
 *
 * `webServer` builds `dist/` once (via `npm run build`, already run before `test:e2e` — see
 * package.json) is NOT invoked here on purpose: building is slow and `test:e2e` already depends on
 * a fresh `dist/`. This config only starts the static preview server against the existing `dist/`.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    // vite preview's default host binds to `localhost` only (not the `127.0.0.1` IPv4 literal) on
    // this machine — using `localhost` here (not `127.0.0.1`) for both the health-check URL and
    // `use.baseURL` above avoids a false "server never started" timeout.
    command: 'npm run preview -- --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
