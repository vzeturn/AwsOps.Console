/**
 * Public surface of the `infra` domain module (backend-core-foundation Task 24): the Infra tab
 * handler/service (EC2/RDS/ALB overview, `GET /infra`), the Infra Map handler/collector (`GET
 * /topology`), and the 7 raw data collectors that ONLY `infra-review-collector/
 * assessment-report-builder.ts` (a DIFFERENT module, `assessment`) calls to build the daily
 * Assessment report: `ec2-collector.ts`, `rds-collector.ts`, `networking-collector.ts`,
 * `storage-collector.ts`, `serverless-collector.ts`, `elastic-ip-collector.ts`, and
 * `compute-optimizer-collector.ts` (the official AWS Compute Optimizer data source, used for
 * rightsizing decisions across both this module and `governance`).
 *
 * `time-of-day-collector.ts` stays OUT of this module — it lives in `collectors/` and is tightly
 * coupled to the `governance`/`assessment` time-of-day-sizing feature, not general infra survey.
 *
 * Only re-exports symbols that have a REAL external importer today (same convention as
 * `modules/assessment/index.ts`/`modules/cost/index.ts`). Every current external importer in this
 * codebase imports via a DIRECT relative file path rather than through this barrel — the same
 * established pattern already in place for every other relocated module. This file exists to
 * document the module's public surface and satisfy the one-barrel-per-module requirement; it is
 * not itself imported by any consumer yet.
 *
 * - `infraHandler` (renamed from `handler`, get-infra.ts) — imported by `router.ts`.
 * - `getInfraData` (infra-service.ts) — imported by `infra-collector.ts`,
 *   `modules/ec2-management/instanceInInfraCache.ts`, `modules/export/export-csv.ts`.
 * - `loadAlb` (infra-service.ts) — imported by `modules/monitoring/monitoring-service/online-resources.ts`
 *   (reused directly, no copy-paste, so `InfraTab`/Monitoring_Page threshold behavior for ALBs
 *   never drifts apart).
 * - `topologyHandler` (renamed from `handler`, get-topology.ts) — imported by `router.ts`.
 * - `collectTopology` (topology-collector.ts) — imported by `infra-collector.ts`.
 * - `collectEc2`/`collectRds`/`collectNetworkingData`/`getStorageData`/`collectServerless`/
 *   `collectElasticIps`/`collectComputeOptimizerData` (the 7 raw collectors) — imported by
 *   `modules/assessment/infra-review-collector/assessment-report-builder.ts` (a DIFFERENT
 *   module, so this counts as an external importer even though `infra-review-collector.ts` itself
 *   is the only caller).
 * - `fetchEc2RecommendationDetail`/`NORMALIZED_FINDING`/`type Ec2TopRecommendationOption`
 *   (compute-optimizer-collector.ts) — imported by `modules/governance/ec2-rightsize-applier.ts`
 *   and `modules/governance/ec2AutoRightsizing.ts`.
 *
 * `extractAlbArnSuffix` (infra-service.ts) has no external importer — only this module's own
 * `infra-service.test.ts` references it directly; not re-exported here.
 */
export { handler as infraHandler } from './get-infra.js';
export { getInfraData, loadAlb } from './infra-service.js';
export { handler as topologyHandler } from './get-topology.js';
export { collectTopology } from './topology-collector.js';
export { collectEc2 } from './ec2-collector.js';
export { collectRds } from './rds-collector.js';
export { collectNetworkingData } from './networking-collector.js';
export { getStorageData } from './storage-collector.js';
export { collectServerless } from './serverless-collector.js';
export { collectElasticIps } from './elastic-ip-collector.js';
export {
  collectComputeOptimizerData,
  fetchEc2RecommendationDetail,
  NORMALIZED_FINDING,
  type Ec2TopRecommendationOption,
} from './compute-optimizer-collector.js';
