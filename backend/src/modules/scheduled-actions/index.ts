/**
 * `scheduled-actions` Domain_Module — public export surface for anything outside this module that
 * needs to reference the Scheduled Actions feature's own symbols. External importers confirmed via
 * grep (backend-core-foundation Task 16.1): `router.ts` imports `getScheduledActionsHandler` from
 * `get-scheduled-actions.ts` and `createHandler`/`deleteHandler` from `scheduled-actions-execute.ts`
 * directly (not via this barrel), since they were already wired that way before this module
 * existed; this barrel exists for consistency with every other Domain_Module (Requirement 6.2) and
 * is available for future callers. `scheduled-actions-mutate-handler.ts` is a standalone Lambda
 * entrypoint (invoked only via `lambda:InvokeFunction`, bundled individually by
 * `infra/scripts/build-artifacts.mjs`) — nothing imports its `handler` directly, so it is NOT
 * exported here, matching the convention already used for the other mutate-Lambda entrypoints
 * (e.g. `alerting`'s 4 Lambda entrypoints).
 */
export { handler as getScheduledActionsHandler } from './get-scheduled-actions.js';
export { createHandler as createScheduleHandler, deleteHandler as deleteScheduleHandler } from './scheduled-actions-execute.js';
