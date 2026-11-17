import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, basename } from 'path';
import { fileURLToPath } from 'url';

// Feature: infra-review-dashboard-revamp, Requirement 14.1
// Only the 2 Lambdas that run on a fixed schedule (`cost-collector.ts` and
// `infra-review-collector.ts`, plus the collectors under `collectors/` that ONLY
// `infra-review-collector.ts` calls) are allowed to call paid AWS APIs (Cost Explorer /
// CloudWatch). The router and the services that serve the request path directly from the frontend
// (router.ts, assessment-service.ts, compliance-service.ts, infra-service.ts, cost-service.ts)
// must NOT directly import `@aws-sdk/client-cost-explorer` or `@aws-sdk/client-cloudwatch`, to
// ensure requests from the frontend (auto-refresh) don't incur AWS costs outside the 2 collector
// Lambdas' fixed schedule.
//
// NOTE: `tasks.md`/`design.md` originally listed the allowlist as just `cost-collector.ts` and
// `infra-review-collector.ts` (written before Task 6 split the raw data collection logic out into
// `collectors/*.ts`). In practice `infra-review-collector.ts` (the Lambda entrypoint) only imports
// the `collectors/*.ts` modules and pure functions in `lib/recommendations.ts` — it's the
// collectors under `collectors/` that directly import
// `@aws-sdk/client-cloudwatch`/`@aws-sdk/client-cost-explorer`. These collectors are only called
// by `infra-review-collector.ts` (not on the router's request path), so this still satisfies the
// intent of Requirement 14.1 — the test below reflects the actual list of files that import these
// 2 packages, while still preserving the core assertion: router.ts and the request-path services
// must not import these 2 packages (the second assertion below, matching the task's original description).
//
// UPDATE (spec `realtime-monitoring-dashboard`): `monitoring-service.ts` is the ONE DELIBERATE
// EXCEPTION by design (see design.md, Architecture section: "this is the only exception in
// Ops_Dashboard allowed to call paid AWS APIs when the user clicks refresh, per Requirement 7") —
// this service runs on `router.ts`'s `GET /monitoring` request path and calls CloudWatch
// `GetMetricData`/`ListMetrics` directly to achieve ≤60s latency (Requirement 7.1/7.2), unlike
// every other request-path service (which only reads the cache pre-written by
// `cost-collector`/`infra-review-collector`). So `monitoring-service.ts` is added to the allowlist
// here deliberately, NOT by oversight — the second assertion below (router.ts and the cache-only
// services) is unchanged. For the same reason, `alert-service.ts` (Task 5.1) also runs on the
// `GET /monitoring` request path and calls `DescribeAlarms` (CloudWatch, free tier) directly —
// the same deliberate exception, added to the allowlist alongside `monitoring-service.ts`.
//
// `alarm-baseline-manager.ts` (a NEW Lambda, "standard alarm set" — implementing the requirement
// "replace all alarms with our standard alarm set") ONLY calls
// `DescribeAlarms`/`PutMetricAlarm`/`DeleteAlarms` (alarm management — free tier, NOT
// `GetMetricData`/paid custom metrics) and runs on an EventBridge Scheduler (like
// `cost-collector.ts`/`infra-review-collector.ts`), NOT on router.ts's request path — added to the
// allowlist per Requirement 14.1's principle (only fixed-schedule Lambdas may import this package).


const SRC_DIR = fileURLToPath(new URL('..', import.meta.url));

const PAID_API_PACKAGES = ['@aws-sdk/client-cost-explorer', '@aws-sdk/client-cloudwatch'] as const;

const ALLOWED_BASENAMES = new Set([
  'cost-collector.ts',
  // Collectors under backend/src/collectors/ — only imported/called by infra-review-collector.ts,
  // not on router.ts's request path (see note above).
  'ec2-collector.ts',
  'rds-collector.ts',
  'networking-collector.ts',
  'storage-collector.ts',
  'serverless-collector.ts',
  'savings-plans-collector.ts',
  'time-of-day-collector.ts',
  // Deliberate exception from the `realtime-monitoring-dashboard` spec — see note above.
  // (monitoring-service.ts is now a pure re-export barrel, no longer imports the paid package
  // itself — the real logic lives in get-monitoring-data.ts below. clients.ts, split out of
  // monitoring-service.ts, used to import '@aws-sdk/client-cloudwatch' directly too, but now
  // constructs its CloudWatch client via core/aws-clients.ts's getCloudWatchClient() instead
  // (backend-core-foundation Task 11), so it no longer imports the paid package directly and is
  // no longer listed here.)
  'alert-service.ts',
  'cwagent-detection.ts',
  'get-monitoring-data.ts',
  'metric-definitions.ts',
  // NEW fixed-schedule Lambda that only manages alarms (free tier) — see note above.
  'alarm-baseline-manager.ts',
  // Idle-to-Zero feature (idle-scheduler module). Same class of deliberate exception as
  // alert-service.ts/alarm-baseline-manager.ts above: all 4 of these call ONLY free-tier
  // CloudWatch alarm/metric-read APIs (DescribeAlarms/PutMetricAlarm/DeleteAlarms/
  // EnableAlarmActions/GetMetricStatistics/PutMetricData), never GetMetricData-for-cost or
  // Cost Explorer.
  // - idle-scheduler-tick.ts / idle-scheduler-watchdog.ts: fixed-schedule Lambdas (EventBridge
  //   Scheduler, rate(5 minutes)/rate(60 minutes)), not on router.ts's request path.
  // - idle-scheduler-mutate-handler.ts: dedicated mutate Lambda invoked only via
  //   lambda:InvokeFunction from the router (same separation pattern as
  //   scheduled-actions-mutate-handler.ts/action-execution-fn) — manages the per-group wake alarm.
  // - get-idle-scheduler.ts: router-facing GET /idle-scheduler handler — reads live alarm state
  //   (DescribeAlarms) the same way alert-service.ts already does on the request path.
  'idle-scheduler-tick.ts',
  'idle-scheduler-watchdog.ts',
  'idle-scheduler-mutate-handler.ts',
  'get-idle-scheduler.ts',
  // core/aws-clients.ts (backend-core-foundation, Requirement 1) is the centralized AWS SDK
  // client factory — it necessarily imports EVERY AWS SDK package used anywhere in this
  // codebase, including the 2 paid ones, so it can provide getCloudWatchClient()/
  // getCostExplorerClient() to callers. It does NOT itself call a paid API — it only constructs
  // the client. TODO(backend-core-foundation Task 11): once every current importer of
  // '@aws-sdk/client-cost-explorer'/'@aws-sdk/client-cloudwatch' migrates to
  // core/aws-clients.ts's getters instead of importing the SDK package directly, this whole
  // test's premise (checking WHICH FILE IMPORTS THE PACKAGE) stops being meaningful — at that
  // point this test should be rewritten to check which file calls
  // getCostExplorerClient()/getCloudWatchClient() instead, the same way this file's own docstring
  // already documents the router.ts/request-path invariant this test protects.
  'aws-clients.ts',
]);

/** Recursively lists all .ts files in `dir`, skipping test directories and the dist build. */
function listTsFilesRecursively(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue;
      files.push(...listTsFilesRecursively(fullPath));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

function importsPaidApiPackage(fileContent: string): boolean {
  return PAID_API_PACKAGES.some((pkg) => {
    const importRegex = new RegExp(`from\\s+['"]${pkg.replace(/[/.]/g, '\\$&')}['"]`);
    return importRegex.test(fileContent);
  });
}

describe('backend static architecture check - restricts permission to call paid APIs', () => {
  it('only cost-collector.ts and the collectors under collectors/ may import @aws-sdk/client-cost-explorer or @aws-sdk/client-cloudwatch', () => {
    const allTsFiles = listTsFilesRecursively(SRC_DIR);

    const filesImportingPaidApi = allTsFiles
      .filter((filePath) => importsPaidApiPackage(readFileSync(filePath, 'utf-8')))
      .map((filePath) => basename(filePath));

    expect(new Set(filesImportingPaidApi)).toEqual(ALLOWED_BASENAMES);
  });

  it('router.ts, assessment-service.ts, compliance-service.ts, infra-service.ts, cost-service.ts do not import paid APIs', () => {
    const filesToCheck = [
      join(SRC_DIR, 'modules', 'web', 'router.ts'),
      join(SRC_DIR, 'modules', 'assessment', 'assessment-service.ts'),
      join(SRC_DIR, 'modules', 'compliance', 'compliance-service.ts'),
      join(SRC_DIR, 'modules', 'infra', 'infra-service.ts'),
      join(SRC_DIR, 'modules', 'cost', 'cost-service.ts'),
    ];

    for (const filePath of filesToCheck) {
      const content = readFileSync(filePath, 'utf-8');
      expect(importsPaidApiPackage(content), `${basename(filePath)} must not import a paid AWS API`).toBe(false);
    }
  });
});
