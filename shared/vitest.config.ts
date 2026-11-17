import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // No other test files exist yet in this package — avoid vitest exiting with code 1 just
    // because of "no test files found", which isn't an actual test failure (same pattern used in
    // backend/vitest.config.ts).
    passWithNoTests: true,
  },
});
