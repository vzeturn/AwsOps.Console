/**
 * Public surface of the `assessment` domain module (backend-core-foundation Task 23): the
 * Assessment tab handler/service (reads the cached `assessment-report.json`), and the
 * `infra-review-collector.ts` standalone Lambda (a barrel over `infra-review-collector/`) that is
 * the ONLY caller of the paid CloudWatch/Compute Optimizer/Cost Explorer coverage APIs used to
 * build that report (Requirement 14.2). This is the MOST cross-referenced module in the codebase:
 * `infra-review-collector/assessment-report-builder.ts` pulls in raw collectors plus already-
 * relocated modules (`cost`, `alerting`, `governance`, `logs`, `ec2-management`, `compliance`),
 * and — in the OTHER direction — `modules/governance/s3PolicyStore.ts` imports
 * `infra-review-collector/clients.ts`'s S3 client/bucket name constant.
 *
 * Only re-exports symbols that have a REAL external importer today (same convention as
 * `modules/cost/index.ts`/`modules/compliance/index.ts`/`modules/security/index.ts`). Every
 * current external importer in this codebase imports via a DIRECT relative file path rather than
 * through this barrel — that is the established pattern already in place for every other
 * relocated module, not something new here. This file exists to document the module's public
 * surface and satisfy the one-barrel-per-module requirement; it is not itself imported by any
 * consumer yet.
 *
 * - `assessmentHandler` (renamed from `handler`) — imported by `router.ts`.
 * - `getAssessmentData` — imported by `modules/actions/preview-service.ts`.
 *
 * `s3`/`ASSESSMENT_BUCKET_NAME` (from `infra-review-collector/clients.ts`) are DELIBERATELY NOT
 * re-exported here even though `modules/governance/s3PolicyStore.ts` reaches into this module's
 * internal `infra-review-collector/` subdirectory: `s3PolicyStore.ts` is used by
 * `infra-review-collector-fn`/`time-of-day-trigger-fn` (lean standalone Lambdas), and this
 * barrel also re-exports `assessment-service.ts`, which imports the `config.ts` singleton at
 * module scope — routing through this barrel would make those Lambdas depend on env vars they
 * are never granted (see `lambda-boot.test.ts`). `s3PolicyStore.ts` therefore imports
 * `clients.js` by direct file path instead, as a documented Requirement 6.4 exception.
 *
 * The `handler` exported from `infra-review-collector.ts` is NOT re-exported here —
 * `lambda-boot.test.ts` (the only thing that references it outside this module) references it as
 * a bundling/table entry by FILE PATH (`'./modules/assessment/infra-review-collector.js'`, a
 * dynamic `import()`), not by importing the function BY NAME through this barrel — the same
 * reason `modules/cost/index.ts` doesn't re-export `cost-collector.ts`'s handler either.
 *
 * The pure classification functions in `recommendations.ts` (`classifyByThreshold`,
 * `classifyByState`, `computePriority`, `buildSavingsPlanRecommendation`, `sortByPriorityDesc`,
 * `buildProtectionGapFinding`) are NOT re-exported here — their only importer is
 * `infra-review-collector/assessment-report-builder.ts`, which now lives INSIDE this same module,
 * so that usage does not count as "external".
 */
export { handler as assessmentHandler } from './get-assessment.js';
export { getAssessmentData } from './assessment-service.js';
