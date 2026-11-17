import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from 'aws-lambda';
import type { MonitoringData } from '@ops-dashboard/shared';
import { ok } from '../../shared-kernel/response.js';
import { buildMonitoringSnapshot } from './monitoring-snapshot.js';
import { MONITORING_CACHE_S3_KEY, MONITORING_CACHE_TTL_MS, isSnapshotFresh } from '../ec2-management/index.js';
import { readCachedJson, writeCachedJson } from '../../shared-kernel/s3Cache.js';

/**
 * Lazy write-through cache, NOT the scheduled-collector pattern used by `/infra` and `/compliance`.
 *
 * The difference is deliberate and was driven by measurement. `getMonitoringData()` calls CloudWatch
 * `GetMetricData`, which is billed per metric requested and is excluded from the free tier
 * (https://aws.amazon.com/cloudwatch/pricing/). Two facts about this deployment decide the design:
 *
 *   - Serving it live on every request couples the bill to CLIENT BEHAVIOUR. The frontend polls this
 *     route on a timer with `refetchIntervalInBackground: true`, so N forgotten background tabs cost
 *     N x ~82 metrics every polling interval, forever. That is an unbounded risk.
 *   - Refreshing it on a fixed schedule instead couples the bill to the SCHEDULE, which at
 *     `rate(5 minutes)` costs ~$0.24/day whether anyone opens the dashboard or not. Measured reality:
 *     the router receives ~21 requests/DAY in total. A schedule would have made this route roughly
 *     10x more expensive than leaving it live.
 *
 * A TTL cache gets both properties. Cost tracks actual usage (near zero at 21 requests/day), while the
 * TTL puts a hard ceiling on it: at most one rebuild per `MONITORING_CACHE_TTL_MS` no matter how many
 * tabs are polling, so the pathological case is capped at the same ~$0.24/day the schedule would have
 * cost as its BASELINE. Repeat views inside the window are also served from S3 in ~50ms instead of
 * re-running the whole Describe+GetMetricData sequence.
 *
 * Concurrency: two requests arriving together can both rebuild and both write. That is acceptable and
 * left unhandled on purpose — the write replaces one whole object (no partial state, last writer
 * wins), and at this request volume the overlap is rare. Locking would cost more complexity than the
 * duplicate call it avoids.
 */
export async function handler(event: LambdaFunctionURLEvent): Promise<LambdaFunctionURLResult> {
  const cached = await readCachedJson<MonitoringData>(MONITORING_CACHE_S3_KEY);
  if (cached && isSnapshotFresh(cached.generatedAt, MONITORING_CACHE_TTL_MS)) {
    return ok(event, cached);
  }

  const fresh = await buildMonitoringSnapshot();
  // Best-effort: a failed cache write must not fail a response we already have in hand. The only
  // consequence is that the next request rebuilds too (see `writeCachedJson`, which never throws).
  await writeCachedJson(MONITORING_CACHE_S3_KEY, fresh);
  return ok(event, fresh);
}
