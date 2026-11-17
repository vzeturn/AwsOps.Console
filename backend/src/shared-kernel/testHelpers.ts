/**
 * `testHelpers.ts` — shared test-only helpers for unit tests that need to mock `config.ts`
 * (`AppConfig`) or build a fake `LambdaFunctionURLEvent`. Extracted after finding the exact same
 * `AppConfig`-shaped object hand-copied verbatim into `actions-ec2-management.test.ts` and
 * `actions-security-group.test.ts` (and several other `actions-*.test.ts` files) — every one of
 * those tests only actually reads a handful of fields (`awsRegion`, `operatorGroupIds`,
 * `actionExecutionFunctionName`...), so a single source of the FULL shape means adding a new
 * required `AppConfig` field only has to update one place instead of every copy.
 *
 * NOTE ON `vi.mock` HOISTING: `vitest` hoists every `vi.mock(...)` call to the top of the test
 * file, above regular imports — a test file MUST still write its own `vi.mock('../../config.js',
 * () => ({ config: buildMockAppConfig(...), corsHeaders: () => ({}) }))` call (this file cannot
 * do that FOR the caller, since the mock factory has to live in the file vitest hoists it from).
 * What this file removes is having to re-type/copy the full `AppConfig` object literal itself —
 * callers only override the 1-2 fields relevant to what they're testing.
 */
import type { LambdaFunctionURLEvent } from 'aws-lambda';
import type { AppConfig } from '../config.js';

/**
 * Builds a complete, valid `AppConfig` object for use inside a `vi.mock('../../config.js', ...)`
 * factory — every field has a harmless placeholder value, so a test only needs to override the
 * 1-2 fields it actually cares about (e.g. `operatorGroupIds`, `actionExecutionFunctionName`).
 */
export function buildMockAppConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    allowedOrigins: [],
    entraTenantId: 'test-tenant',
    entraClientId: 'test-client',
    allowedGroupIds: [],
    operatorGroupIds: ['operator-group-1'],
    awsRegion: 'ap-southeast-1',
    awsAccountId: '123456789012',
    assessmentBucketName: 'test-assessment-bucket',
    ec2StateManagerServiceTokenParamName: '/test/ec2-state-manager-service-token',
    ec2StateManagerFunctionUrl: 'https://ec2-state-manager.invalid/',
    actionExecutionFunctionName: 'test-action-execution-fn',
    scheduledActionsMutateFunctionName: 'test-scheduled-actions-mutate-fn',
    approvalMutateFunctionName: 'test-approval-mutate-fn',
    idleSchedulerMutateFunctionName: 'test-idle-scheduler-mutate-fn',
    findingsMutateFunctionName: 'test-findings-mutate-fn',
    ...overrides,
  };
}

/**
 * Builds a minimal `LambdaFunctionURLEvent` with a JSON-stringified body — the exact `makeEvent`/
 * `buildEvent` helper duplicated (under slightly different names) across every `actions-*.test.ts`
 * file in this project. Extra fields (`headers`, `rawPath`, `requestContext`) can be merged in via
 * `overrides` for the handful of tests that read them (e.g. CORS/path-based tests).
 */
export function buildMockEvent(body: unknown, overrides: Partial<LambdaFunctionURLEvent> = {}): LambdaFunctionURLEvent {
  return { body: JSON.stringify(body), ...overrides } as unknown as LambdaFunctionURLEvent;
}
