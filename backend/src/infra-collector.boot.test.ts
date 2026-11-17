import { describe, it, expect, afterEach } from 'vitest';

/**
 * BOOT-LEVEL SMOKE TEST — "can this Lambda cold-start at all?".
 *
 * `infra-collector.test.ts` `vi.mock()`s both services at the module boundary, so the REAL
 * import graph (and therefore `config.ts` — a singleton that throws when env is missing) is
 * NEVER evaluated in that test: it stays green even if the Lambda dies in its module
 * initializer on every real invocation. This test deliberately mocks NOTHING and imports the
 * module entry point with the EXACT set of environment variables CloudFormation grants
 * `InfraCollectorFunction` (`ASSESSMENT_BUCKET_NAME` + `AWS_ACCOUNT_ID`, plus `AWS_REGION` which
 * the Lambda runtime sets automatically — see `infra/ops-dashboard.yaml`), with the
 * router-only variables deleted entirely.
 *
 * Red = some transitive import pulled `config.js` (or a similar fail-loud module) into the
 * collector — an error that would only surface in CloudWatch (the cache never gets written, the
 * router silently falls back to calling AWS directly forever, the alarm fires 288 times/day) if
 * it isn't caught here.
 */
const CFN_PROVIDED_ENV: Record<string, string> = {
  ASSESSMENT_BUCKET_NAME: 'test-assessment-bucket',
  AWS_ACCOUNT_ID: '123456789012',
  AWS_REGION: 'ap-southeast-1',
};

/** Required `config.ts` variables that `InfraCollectorFunction.Environment.Variables` does NOT provide. */
const ROUTER_ONLY_ENV = [
  'ENTRA_TENANT_ID',
  'ENTRA_CLIENT_ID',
  'EC2_STATE_MANAGER_SERVICE_TOKEN_PARAM_NAME',
  'EC2_STATE_MANAGER_FUNCTION_URL',
  'ACTION_EXECUTION_FUNCTION_NAME',
  'SCHEDULED_ACTIONS_MUTATE_FUNCTION_NAME',
];

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('infra-collector cold start', () => {
  it('imports the entire module graph with the EXACT CloudFormation-provided env (no config singleton pulled in)', async () => {
    for (const name of ROUTER_ONLY_ENV) delete process.env[name];
    Object.assign(process.env, CFN_PROVIDED_ENV);

    const mod = await import('./infra-collector.js');

    expect(typeof mod.handler).toBe('function');
    // Explicit timeout (default is 5000ms): this test imports the real, unmocked module graph,
    // which is a few hundred ms in isolation but has been observed to exceed 5s purely from CPU
    // contention when `npm run test --workspaces` runs backend/frontend/shared in parallel on a
    // busy machine (confirmed by re-running this file alone — passes in <1s every time). This is
    // NOT a fix for a real regression, just enough headroom to stop a resource-contention flake
    // from failing the deploy gate.
  }, 20000);

  it('config.ts still fails loud when required env is missing (so the test above is not green for the wrong reason)', async () => {
    for (const name of ROUTER_ONLY_ENV) delete process.env[name];
    Object.assign(process.env, CFN_PROVIDED_ENV);

    await expect(import('./config.js')).rejects.toThrow('Missing required environment variable: ENTRA_TENANT_ID');
  });
});
