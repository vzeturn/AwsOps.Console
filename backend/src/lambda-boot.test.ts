import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * BOOT-LEVEL SMOKE TEST FOR EVERY LAMBDA IN THE STACK.
 *
 * WHY THIS EXISTS — a real 10-day production outage:
 *   health-report-fn        died on EVERY invocation from 2026-08-25, "Missing required environment
 *                           variable: ASSESSMENT_BUCKET_NAME"   (288 failures/day for 10 days)
 *   time-of-day-trigger-fn  died on EVERY invocation from 2026-08-28, "Missing required environment
 *                           variable: AWS_ACCOUNT_ID"           (288 failures/day for 7 days)
 *
 * Neither was caught by anything. The normal unit tests `vi.mock()` their dependencies at the module
 * boundary, so the REAL import graph — and therefore the module-scope `throw` that kills the
 * function — is never evaluated. And the Lambda Errors alarms went to ALARM once on day one and
 * stayed there, so they never re-notified: a stuck alarm is indistinguishable from a handled one.
 *
 * The failure mode is nasty because it needs no code change to appear. Adding an ordinary-looking
 * import to a handler can transitively pull in a module that reads an env var at module scope
 * (`config.ts`, `threshold-history-service.ts`, `modules/infra/awsRegion.ts`, ...). The handler still compiles,
 * still passes every unit test, and then dies 100% of the time in production.
 *
 * `infra-collector.boot.test.ts` already did this for ONE Lambda. This file generalises it to all of
 * them, driven by the CloudFormation template itself, so the check cannot drift from what is actually
 * deployed: the env each Lambda is granted is READ OUT OF `infra/ops-dashboard.yaml` rather than
 * duplicated here.
 */

const REPO_ROOT = path.join(process.cwd(), '..');
const TEMPLATE = path.join(REPO_ROOT, 'infra', 'ops-dashboard.yaml');

/**
 * Lambda logical ID -> entry module, mirroring the bundle list in `infra/scripts/build-artifacts.mjs`.
 * `StaticServerFunction` is excluded: its entry lives in `infra/`, outside this workspace's rootDir.
 */
const ENTRY_BY_FUNCTION: Record<string, string> = {
  RouterFunction: './modules/web/router.js',
  CostCollectorFunction: './modules/cost/cost-collector.js',
  InfraReviewCollectorFunction: './modules/assessment/infra-review-collector.js',
  InfraCollectorFunction: './infra-collector.js',
  ActionExecutionFunction: './modules/actions/action-execution-handler.js',
  DiscordAlarmNotifierFunction: './modules/alerting/alarm-notifier.js',
  AlarmBaselineManagerFunction: './modules/alerting/alarm-baseline-manager.js',
  HealthReportFunction: './modules/alerting/health-report.js',
  PatchSchedulerFunction: './modules/governance/patch-scheduler.js',
  Ec2RightsizeApplierFunction: './modules/governance/ec2-rightsize-applier.js',
  DownsizeSchedulerFunction: './modules/governance/downsize-scheduler.js',
  TimeOfDayTriggerFunction: './modules/governance/time-of-day-trigger.js',
  ScheduledActionsMutateFunction: './modules/scheduled-actions/scheduled-actions-mutate-handler.js',
  ApprovalMutateFunction: './modules/actions/approval-mutate-handler.js',
};

/**
 * Extracts, for each Lambda, the set of `Environment.Variables` keys the template grants it.
 *
 * Deliberately a line scanner rather than a YAML parse: the template uses CloudFormation short-form
 * intrinsic tags (`!Ref`, `!GetAtt`, `!Sub`) that a plain YAML loader rejects, and the alternative —
 * registering constructors for all of them — is a lot of machinery for "which keys are listed".
 * Only the KEY NAMES matter here; the values are irrelevant to whether boot succeeds.
 */
function envKeysPerFunction(): Map<string, string[]> {
  const lines = readFileSync(TEMPLATE, 'utf8').split(/\r?\n/);
  const result = new Map<string, string[]>();

  let currentFn: string | null = null;
  let inVariables = false;
  let variablesIndent = 0;

  for (const line of lines) {
    const resource = /^ {2}(\w+):\s*$/.exec(line);
    if (resource) {
      currentFn = resource[1] in ENTRY_BY_FUNCTION ? resource[1] : null;
      inVariables = false;
      continue;
    }
    if (!currentFn) continue;

    if (/^\s*Variables:\s*$/.test(line)) {
      inVariables = true;
      variablesIndent = line.search(/\S/);
      result.set(currentFn, result.get(currentFn) ?? []);
      continue;
    }
    if (!inVariables) continue;

    const indent = line.search(/\S/);
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    if (indent <= variablesIndent) {
      inVariables = false;
      continue;
    }
    const key = /^\s*([A-Z][A-Z0-9_]*):/.exec(line);
    if (key) result.get(currentFn)!.push(key[1]);
  }
  return result;
}

/**
 * A placeholder value for one env var. Most modules only check that the variable is non-empty, so a
 * generic string is enough — but a few PARSE their value at module scope, and those need something
 * structurally valid or the test fails for the wrong reason (an invalid IANA timezone throws
 * `RangeError: Invalid time zone specified`, which looks like a boot bug but is a bad fixture).
 */
function fakeValueFor(key: string): string {
  if (key === 'PATCH_TIMEZONE') return 'Asia/Ho_Chi_Minh';
  if (key === 'AWS_ACCOUNT_ID') return '123456789012';
  if (key.endsWith('_ARN')) return 'arn:aws:lambda:ap-southeast-1:123456789012:function:test-fn';
  if (key.endsWith('_URL') || key.endsWith('_ORIGINS')) return 'https://example.invalid';
  return `test-${key.toLowerCase()}`;
}

const ENV_KEYS = envKeysPerFunction();
const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  vi.resetModules();
});

describe('every Lambda cold-starts with ONLY the environment CloudFormation grants it', () => {
  it('the template scan found all the Lambdas (guards against the scanner silently matching nothing)', () => {
    for (const fn of Object.keys(ENTRY_BY_FUNCTION)) {
      expect(ENV_KEYS.has(fn), `${fn} not found in ${TEMPLATE} — did a resource get renamed?`).toBe(true);
    }
  });

  /**
   * These tests are unlike the rest of the suite: each one performs a REAL dynamic `import()` of a
   * Lambda entry point, so it transpiles and evaluates that entry's entire module graph. The router
   * is the largest graph in the project and took 5032 ms against the default 5000 ms timeout during a
   * full-workspace run, where ~11 vitest workers compete for CPU — it failed the deploy gate while
   * passing when the backend suite ran on its own.
   *
   * The timeout is raised rather than the import being trimmed, because importing the real graph is
   * the entire point: ordinary unit tests `vi.mock()` the dependencies away, which is exactly why a
   * module-scope `throw` on a missing environment variable killed three Lambdas in production without
   * any test noticing. A slow-but-honest test is worth more than a fast mocked one here.
   */
  const BOOT_TIMEOUT_MS = 30_000;

  for (const [fn, entry] of Object.entries(ENTRY_BY_FUNCTION)) {
    it(`${fn} boots`, async () => {
      const keys = ENV_KEYS.get(fn) ?? [];

      // Start from an environment containing ONLY what the Lambda runtime injects (AWS_REGION) plus
      // exactly the variables the template declares. Everything else is removed, so a module that
      // reads some other variable at import time fails here the same way it fails in production.
      const fresh: NodeJS.ProcessEnv = { AWS_REGION: 'ap-southeast-1' };
      for (const key of keys) {
        fresh[key] = fakeValueFor(key);
      }
      process.env = fresh;
      vi.resetModules();

      await expect(import(entry)).resolves.toBeDefined();
    }, BOOT_TIMEOUT_MS);
  }
});
