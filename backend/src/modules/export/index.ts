/**
 * Public surface of the `export` domain module (backend-core-foundation Task 20): CSV export for
 * the infra/compliance/cost tabs.
 *
 * Only re-exports the symbol with a REAL external importer today (`handler`, imported by
 * `router.ts`) — matches the documentation-only barrel convention already used by every other
 * relocated module (`router.ts` imports via a direct relative path, not through this barrel).
 */
export { handler } from './export-csv.js';
