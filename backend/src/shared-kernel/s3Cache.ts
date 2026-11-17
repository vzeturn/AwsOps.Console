import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getS3Client } from '../core/aws-clients.js';
import { config } from '../config.js';
import { logger } from './logger.js';

/**
 * Reads 1 cached JSON object from `AssessmentReportBucket` (written on a schedule by the collector
 * Lambdas — `infra-collector.ts`, see `modules/ec2-management/infraCacheKey.ts` for the list of keys).
 *
 * Shared by EVERY cache read path in the router (`GET /infra`, `GET /compliance`, `GET /export/*`)
 * — previously each handler repeated the same `GetObjectCommand` → `transformToString()` →
 * `JSON.parse` block and swallowed errors itself, and `export-csv.ts` was left out entirely (it
 * still called AWS Describe directly, so the exported CSV could drift from the snapshot shown in
 * the table).
 *
 * Returns `undefined` (does NOT throw) when the object doesn't exist yet (the collector's first
 * run) or the content is corrupted — every caller MUST fall back to calling the AWS Describe API
 * directly, so the dashboard/export can still display data.
 */
const s3 = getS3Client();

export async function readCachedJson<T>(key: string): Promise<T | undefined> {
  try {
    const { Body } = await s3.send(new GetObjectCommand({ Bucket: config.assessmentBucketName, Key: key }));
    const raw = await Body?.transformToString();
    return raw ? (JSON.parse(raw) as T) : undefined;
  } catch (err) {
    logger.error(`Failed to read S3 cache "${key}" (falling back to direct AWS call)`, err);
    return undefined;
  }
}

/**
 * Writes one cached JSON object back to `AssessmentReportBucket`, for the lazy write-through cache in
 * `modules/monitoring/get-monitoring.ts` (the collector Lambdas do their own writing — they must not depend on
 * `config.ts`, see `infra-collector.boot.test.ts`).
 *
 * NEVER throws. The caller already holds a freshly built response; failing the whole request because
 * the cache could not be updated would turn a cost optimisation into an availability problem. The
 * only consequence of a failed write is that the next request rebuilds as well.
 */
export async function writeCachedJson(key: string, data: unknown): Promise<void> {
  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: config.assessmentBucketName,
        Key: key,
        Body: JSON.stringify(data),
        ContentType: 'application/json',
      }),
    );
  } catch (err) {
    logger.error(`Failed to write S3 cache "${key}" (ignoring — the response is unaffected)`, err);
  }
}
