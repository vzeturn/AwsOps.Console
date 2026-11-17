/**
 * Public surface of the `web` domain module (backend-core-foundation Task 27, the LAST relocation
 * task): the single Lambda "router" exposed via Function URL (`router.ts`, the permanently-$0
 * architecture, NO API Gateway/Cognito), the `GET /me` handler (`me.ts`), and the Microsoft Entra
 * ID JWT verification + group-membership/operator gating (`auth.ts`).
 *
 * This module is intentionally relocated LAST: `router.ts` imports a handler from literally every
 * other domain module (infra/compliance/cost/assessment/monitoring/logs/export/actions/security/
 * ec2-management/scheduled-actions), and `auth.ts`'s `isOperatorMember`/`hasGroupClaimOverage` are
 * imported by many already-relocated modules (`actions`, `ec2-management`, `security`) to gate
 * their own mutating handlers.
 *
 * Only re-exports symbols that have a REAL external importer today (same convention as
 * `modules/monitoring/index.ts`/`modules/infra/index.ts`). Every current external importer in this
 * codebase imports via a DIRECT relative file path rather than through this barrel — the same
 * established pattern already in place for every other relocated module. This file exists to
 * document the module's public surface and satisfy the one-barrel-per-module requirement; it is
 * not itself imported by any consumer yet.
 *
 * - `isOperatorMember` (auth.ts) — imported directly by `modules/actions/actions-lifecycle.ts`,
 *   `modules/actions/actions-preview.ts`, `modules/actions/actions-decide-approval.ts`,
 *   `modules/ec2-management/actions-ec2-management.ts`,
 *   `modules/ec2-management/actions-run-command.ts`,
 *   `modules/ec2-management/get-run-command-status.ts`, and
 *   `modules/security/actions-security-group.ts` (plus each of those files' own `.test.ts` via
 *   `vi.mock('../web/auth.js', ...)`) — the operator gate for every mutating action handler in the
 *   codebase.
 * - `hasGroupClaimOverage` (auth.ts) — imported directly by `me.ts` (this same module, not an
 *   external importer) to expose `operatorStatusUnknown` on `/me`. No importer OUTSIDE this module
 *   references it today.
 *
 * Do NOT include `verifyEntraToken` (auth.ts) — its only importer is `router.ts`, which now lives
 * INSIDE this same module (a same-module reference, not an external one). Do NOT include `handler`
 * from `me.ts` or `handler` from `router.ts` — `router.ts`'s `handler` is the actual Lambda
 * entrypoint bundled directly by file path via `infra/scripts/build-artifacts.mjs` (the same
 * pattern as every other standalone Lambda entrypoint in this codebase), and `me.ts`'s `handler` is
 * only ever called by `router.ts` itself (a same-module reference). Neither has an external
 * importer that would need the barrel.
 */
export { isOperatorMember, hasGroupClaimOverage } from './auth.js';
