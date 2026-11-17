import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from 'aws-lambda';
import type { InfraData } from '@ops-dashboard/shared';
import { ok } from '../../shared-kernel/response.js';
import { getInfraData } from './infra-service.js';
import { INFRA_CACHE_S3_KEY } from '../ec2-management/index.js';
import { readCachedJson } from '../../shared-kernel/s3Cache.js';

/** Reads the S3 cache written by `infra-collector.ts`; falls back to calling the AWS Describe APIs
 * directly when the cache doesn't exist yet or is corrupt (see `lib/s3Cache.ts`). Shares this exact
 * read path with `export-csv.ts` so an exported CSV and the currently displayed table can never
 * drift apart from a snapshot mismatch. */
export async function handler(event: LambdaFunctionURLEvent): Promise<LambdaFunctionURLResult> {
  const cached = await readCachedJson<InfraData>(INFRA_CACHE_S3_KEY);
  const data = cached ?? (await getInfraData());
  return ok(event, data);
}
