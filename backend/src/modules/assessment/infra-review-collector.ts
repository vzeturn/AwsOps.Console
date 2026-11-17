/**
 * Barrel re-export — `infra-review-collector.ts` was split into dedicated modules under
 * `infra-review-collector/` (config/thresholds, reading the previous run's report, Discord
 * embeds, rightsizing decisions + tag application, the `handler()` orchestrator). The old export
 * path/name is kept here so CloudFormation (`infra/ops-dashboard.yaml`, `Handler:`) and the test
 * suite don't need to change.
 */
export { handler } from './infra-review-collector/assessment-report-builder.js';
