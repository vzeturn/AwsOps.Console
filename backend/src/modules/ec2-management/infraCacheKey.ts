/** S3 object keys for the infra/compliance/monitoring caches in AssessmentReportBucket — shared
 * between infra-collector.ts (writer) and get-infra.ts/get-compliance.ts/get-monitoring.ts
 * (readers), avoiding a duplicated literal across multiple places. Follows the same convention as
 * costCacheKey.ts. */
export const INFRA_CACHE_S3_KEY = 'infra-cache.json';
export const COMPLIANCE_CACHE_S3_KEY = 'compliance-cache.json';

/**
 * Unlike the other two keys, this one is NOT written by a scheduled collector. It is a lazy
 * write-through cache owned by `modules/monitoring/get-monitoring.ts` — see the long comment there for why a
 * TTL cache beats both "call CloudWatch live on every request" and "refresh on a schedule" for this
 * particular route.
 */
export const MONITORING_CACHE_S3_KEY = 'monitoring-cache.json';

/**
 * Network structure for the Infra Map — VPCs, subnets and which resource sits where. Written by
 * `infra-collector.ts` alongside the other two, on the same schedule.
 *
 * Piggy-backing on the existing collector rather than adding a Lambda is deliberate: every API the
 * topology needs is FREE, so there is no cost argument for a separate schedule, and a third scheduled
 * function would be a third thing to deploy, monitor and pay cold starts for. Structure also changes
 * far more slowly than the 5-minute cadence it inherits, so the cadence is generous rather than tight.
 */
export const TOPOLOGY_CACHE_S3_KEY = 'topology-cache.json';

/**
 * How long a `monitoring-cache.json` snapshot may be served before `GET /monitoring` rebuilds it.
 *
 * 4 minutes is chosen to sit just under the 5-minute publishing interval of EC2 basic monitoring: a
 * shorter TTL cannot surface fresher datapoints (CloudWatch simply has none yet) and would only pay
 * for `GetMetricData` more often, while a longer one starts hiding datapoints that already exist.
 *
 * This value is also the COST CEILING for the route. Worst case — any number of browser tabs polling
 * continuously — is one rebuild per TTL window: 24h / 4min = 360 rebuilds/day x ~82 metrics x
 * $0.00001 ~= $0.30/day. Raising it lowers that ceiling proportionally; lowering it raises it.
 */
export const MONITORING_CACHE_TTL_MS = 4 * 60 * 1000;

/**
 * Whether a snapshot's `generatedAt` is recent enough to serve. Returns false for a missing,
 * unparseable, or future timestamp — all of which mean "do not trust this, rebuild" rather than
 * "serve it anyway". A clock skew that puts `generatedAt` in the future would otherwise pin the cache
 * as permanently fresh and freeze the dashboard on stale data.
 */
export function isSnapshotFresh(generatedAt: string | undefined, ttlMs: number, now = Date.now()): boolean {
  if (!generatedAt) return false;
  const age = now - new Date(generatedAt).getTime();
  return Number.isFinite(age) && age >= 0 && age < ttlMs;
}
