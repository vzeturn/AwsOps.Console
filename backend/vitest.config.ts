import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // No test files exist yet for some tasks (property/unit tests belonging to tasks marked `*`
    // haven't been implemented in this run) — avoid vitest exiting with code 1 just because of
    // "no test files found", which isn't an actual test failure. Once those test tasks are added,
    // vitest will run them normally.
    passWithNoTests: true,
    // The Lambda runtime ALWAYS sets `AWS_REGION` automatically for every function (a reserved
    // variable), but vitest does not. Modules shared between the router and the Lambda collector
    // read `process.env.AWS_REGION` DIRECTLY (see `src/lib/awsRegion.ts`), so if it's missing the
    // AWS SDK throws "Region is missing" right when a client is constructed at module scope —
    // breaking at the import step, unrelated to the test content. Set it once here instead of
    // repeating it in every test file.
    env: { AWS_REGION: 'ap-southeast-1' },
  },
});
