// `defineConfig` from `vitest/config` (not plain `vite`) so the `test` block below is type-checked —
// it re-exports Vite's own `defineConfig` extended with the `test` field, so this is still a normal
// Vite config for `vite dev`/`vite build`, just with `vitest run` able to read the same file.
import { configDefaults, defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { tanstackRouter } from '@tanstack/router-plugin/vite';

/**
 * ops-dashboard frontend, v2 — full rewrite on Cloudscape Design System (the same design system
 * AWS itself uses for the AWS Management Console) + TanStack Router (type-safe, file-based
 * routing, replacing the previous `useState<DashboardTab>` navigation with real, deep-linkable
 * URLs) + TanStack Query (server state, unchanged choice — already the 2025/2026 standard) +
 * Zustand (client/UI state) + cmdk (command palette).
 *
 * `tanstackRouter()` MUST be listed BEFORE `react()` — it generates `src/routeTree.gen.ts` from
 * the `src/routes/` directory structure at build/dev time, which the React plugin's JSX transform
 * then needs to see already present.
 */
export default defineConfig({
  plugins: [
    tanstackRouter({
      target: 'react',
      autoCodeSplitting: true,
      routesDirectory: './src/routes',
      generatedRouteTree: './src/routeTree.gen.ts',
    }),
    react(),
  ],
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      output: {
        // Splits the biggest, least-often-changing dependencies into their own long-lived cache
        // chunks — the same rationale the previous frontend used for its manualChunks, kept here
        // because it is a build-performance decision independent of which UI library sits on top.
        // Vite 8's rolldown-based builder only accepts a FUNCTION form (the plain object form the
        // Rollup-based builder used to accept throws `manualChunks is not a function` at build time).
        manualChunks(id: string) {
          if (id.includes('node_modules')) {
            // `@xyflow/react`/`elkjs` are DELIBERATELY excluded here (infra-map-redesign spec,
            // Requirement 3.5) — they must land in the `/infra-map` route's own auto-split chunk,
            // not a shared vendor chunk every route pays for. Checked first, before the generic
            // `/react/` substring match below would otherwise catch `@xyflow/react`'s own
            // node_modules path.
            if (id.includes('@xyflow') || id.includes('elkjs')) return undefined;
            if (id.includes('react-dom') || (id.includes('/react/') && !id.includes('react-router') && !id.includes('react-query'))) {
              return 'vendor-react';
            }
            if (id.includes('@tanstack/react-query')) return 'vendor-query';
            if (id.includes('@tanstack/react-router')) return 'vendor-router';
            if (id.includes('oidc-client-ts') || id.includes('react-oidc-context')) return 'vendor-auth';
            if (id.includes('@cloudscape-design')) return 'vendor-cloudscape';
          }
          return undefined;
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    environmentOptions: {
      jsdom: {
        url: 'http://localhost:3000',
      },
    },
    globals: true,
    setupFiles: ['./src/setupTests.ts'],
    // `e2e/**/*.spec.ts` are Playwright specs (run via `npm run test:e2e`, see playwright.config.ts),
    // not Vitest unit tests — without this exclusion, Vitest's default `*.spec.ts` glob picks them
    // up too and fails immediately on `test.describe()` (Playwright's own global, not Vitest's).
    exclude: [...configDefaults.exclude, 'e2e/**'],
  },
});
