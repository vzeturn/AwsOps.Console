import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from 'aws-lambda';
import type { TopologyData } from '@ops-dashboard/shared';
import { ok } from '../../shared-kernel/response.js';
import { collectTopology } from './topology-collector.js';
import { TOPOLOGY_CACHE_S3_KEY } from '../ec2-management/index.js';
import { readCachedJson } from '../../shared-kernel/s3Cache.js';

/**
 * `GET /topology` — network structure for the Infra Map.
 *
 * Same read path as `GET /infra`: serve the S3 cache written by `infra-collector.ts`, and fall back
 * to collecting live only when the cache does not exist yet or is corrupt. The fallback is safe to
 * run on a request because every API `collectTopology()` uses is FREE — unlike `/monitoring`, which
 * has a TTL cache specifically because `GetMetricData` is billed per metric.
 *
 * The fallback exists for the first deploy (cache not written yet) and for the case where the
 * collector is failing; without it the Infra Map would be blank for up to one collector interval
 * after release, which looks like a broken feature rather than a warming cache.
 */
export async function handler(event: LambdaFunctionURLEvent): Promise<LambdaFunctionURLResult> {
  const cached = await readCachedJson<TopologyData>(TOPOLOGY_CACHE_S3_KEY);
  const data = cached ?? (await collectTopology());
  return ok(event, data);
}
