/**
 * `idle-scheduler` Domain_Module — public export surface. `router.ts` imports the router-facing
 * handlers below directly. The 4 standalone Lambda entrypoints (`idle-scheduler-tick.ts`,
 * `idle-scheduler-wake.ts`, `idle-scheduler-watchdog.ts`, `idle-scheduler-mutate-handler.ts`) are
 * invoked only via EventBridge Scheduler / SNS / `lambda:InvokeFunction` respectively, bundled
 * individually by `infra/scripts/build-artifacts.mjs` — nothing imports their `handler` directly,
 * so they are NOT exported here, matching the convention already used for `scheduled-actions`'s
 * own mutate Lambda.
 */
export { handler as getIdleSchedulerHandler } from './get-idle-scheduler.js';
export { createHandler as createIdleSchedulerGroupHandler, deregisterHandler as deregisterIdleSchedulerGroupHandler } from './idle-scheduler-execute.js';
