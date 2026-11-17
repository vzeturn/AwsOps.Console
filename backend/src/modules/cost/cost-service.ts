import { GetObjectCommand } from '@aws-sdk/client-s3';
import type { CostData } from '@ops-dashboard/shared';
import { config } from '../../config.js';
import { evalCostThreshold } from './costThreshold.js';
import { logger } from '../../shared-kernel/logger.js';
import { COST_CACHE_S3_KEY } from './costCacheKey.js';
import { getS3Client } from '../../core/aws-clients.js';

const s3 = getS3Client();

/**
 * Reads cost data from S3 (cost-cache.json in AssessmentReportBucket) — does NOT call Cost
 * Explorer directly on the request path. `GetCostAndUsage` costs $0.01/request; if the router
 * called it directly on every dashboard auto-refresh (60s) that would incur real, unplanned cost.
 * `cost-collector.ts` (a standalone Lambda, EventBridge Schedule every 6h) is the only thing that
 * calls Cost Explorer and writes the result to this object — the router only reads the cache,
 * always free.
 *
 * Used to be SSM Parameter Store Standard tier, but that tier limits values to ONLY 4096 bytes —
 * the cache payload (byService + dailyCostUsd + monthlyHistory) routinely exceeds this limit
 * (worst case ~26.7KB, ~6.5x over), causing cost-collector's cache writes to ALWAYS fail. S3 has
 * no practical size limit for this payload, and the storage/request cost for a small object
 * written every 6h is negligible (cheaper than the SSM Advanced tier at $0.05/month/parameter).
 */
export async function getCostData(): Promise<CostData> {
  try {
    const { Body } = await s3.send(
      new GetObjectCommand({ Bucket: config.assessmentBucketName, Key: COST_CACHE_S3_KEY }),
    );
    const raw = await Body?.transformToString();
    if (!raw) throw new Error('empty');

    const cached = JSON.parse(raw) as Omit<CostData, 'threshold'>;
    // Defensive: the cache may have been written by an older cost-collector version (before the
    // dailyCostUsd field existed) or be partially corrupted — don't fully trust the cached JSON
    // structure.
    const dailyCostUsd = Array.isArray(cached.dailyCostUsd) ? cached.dailyCostUsd : [];
    const monthlyHistory = Array.isArray(cached.monthlyHistory) ? cached.monthlyHistory : [];
    // The cache may have been written by an older cost-collector version (before forecastAvailable
    // existed) — default to true so a valid older cache doesn't wrongly show "No forecast data".
    const forecastAvailable = cached.forecastAvailable ?? true;
    const threshold = evalCostThreshold(cached.forecastMonthUsd, cached.previousMonthUsd);

    return { ...cached, dailyCostUsd, monthlyHistory, forecastAvailable, threshold };
  } catch (err) {
    logger.error('Could not read cost cache (cost-collector may not have run yet)', err);
    return {
      monthToDateUsd: 0,
      forecastMonthUsd: 0,
      forecastAvailable: false,
      previousMonthUsd: 0,
      byService: [],
      threshold: { level: 'warn', reason: 'Cost cache has no data yet — waiting for cost-collector\'s first run (up to 6h)' },
      cachedAt: '',
      dailyCostUsd: [],
      monthlyHistory: [],
    };
  }
}
