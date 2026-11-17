/**
 * Public surface of the `security` domain module (backend-core-foundation Task 17): Security
 * Group read/lifecycle/mutate services + handlers, plus the 3 standalone security-automation
 * Lambdas (`security-guardduty-triage.ts`, `security-public-bucket-guardian.ts`,
 * `security-endpoint-drift-detector.ts`).
 *
 * Only re-exports symbols that have a REAL external importer today:
 * - `executeSecurityGroupIngress`/`executeSecurityGroupEgress`/`executeSecurityGroupCreate`/
 *   `executeSecurityGroupDelete` — imported by `modules/actions/action-execution-handler.ts`.
 * - `actionsSecurityGroupHandler` (renamed from `handler`, actions-security-group.ts) and
 *   `securityGroupsHandler` (renamed from `handler`, get-security-groups.ts) — imported by
 *   `modules/web/router.ts` (Requirement 6.4 — every cross-module import goes through this
 *   `index.ts`, not a direct file path).
 *
 * The 3 standalone Lambda entrypoints (`security-guardduty-triage.ts`,
 * `security-public-bucket-guardian.ts`, `security-endpoint-drift-detector.ts`) are bundled
 * directly by `infra/scripts/build-artifacts.mjs` via their own file path — nothing imports their
 * `handler` export from another module, so they are NOT re-exported here either.
 */
export { executeSecurityGroupIngress } from './security-group-action-service.js';
export { executeSecurityGroupEgress } from './security-group-egress-action-service.js';
export { executeSecurityGroupCreate, executeSecurityGroupDelete } from './security-group-lifecycle-service.js';
export { handler as actionsSecurityGroupHandler } from './actions-security-group.js';
export { handler as securityGroupsHandler } from './get-security-groups.js';
