import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getS3Client } from './core/aws-clients.js';
import { getInfraData } from './modules/infra/infra-service.js';
import { getComplianceData } from './modules/compliance/compliance-service.js';
import { collectTopology } from './modules/infra/topology-collector.js';
import { INFRA_CACHE_S3_KEY, COMPLIANCE_CACHE_S3_KEY, TOPOLOGY_CACHE_S3_KEY } from './modules/ec2-management/infraCacheKey.js';
import { logger } from './shared-kernel/logger.js';

/**
 * Standalone Lambda, triggered by an EventBridge Schedule (defaults to every 5 minutes — see
 * infra/ops-dashboard.yaml, InfraCollectorScheduleExpression) — caches the results of
 * `getInfraData()`/`getComplianceData()` (which call the EC2/RDS/ELB/Backup/DLM/Config
 * Describe APIs directly) into S3 (AssessmentReportBucket), following the SAME architecture
 * already used by cost-collector.ts (get-infra.ts/get-compliance.ts/export-csv.ts prefer
 * reading the S3 cache this Lambda writes, keeping p95 response fast; they only call the
 * Describe APIs directly as a fallback when the cache is empty/broken — e.g. this Lambda has
 * never run yet or is currently failing — which is why RouterRole still needs those Describe
 * permissions).
 *
 * PARTIAL FAILURE: the 2 sources (infra/compliance) are written INDEPENDENTLY via
 * `Promise.allSettled` — if one source fails (e.g. AWS Config isn't enabled on this account),
 * the OTHER source still writes its fresh cache normally, and the failing source's OLD cache is
 * left untouched (never overwritten with empty/broken data) — users still see the stale data
 * along with a "stale data" banner (`isStale()`) instead of losing both tabs entirely.
 */
const s3 = getS3Client();

async function writeCache(bucketName: string, key: string, data: unknown): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: JSON.stringify(data),
      ContentType: 'application/json',
    }),
  );
}

export async function handler(): Promise<{ ok: true }> {
  const bucketName = process.env.ASSESSMENT_BUCKET_NAME;
  if (!bucketName) throw new Error('Missing required environment variable: ASSESSMENT_BUCKET_NAME');

  const [infraResult, complianceResult, topologyResult] = await Promise.allSettled([
    getInfraData().then((data) => writeCache(bucketName, INFRA_CACHE_S3_KEY, data)),
    getComplianceData().then((data) => writeCache(bucketName, COMPLIANCE_CACHE_S3_KEY, data)),
    // Topology (Infra Map) — a third INDEPENDENT source, for the same reason as the other two: a
    // failure here must not cost the user the infra or compliance tab, and must leave the previous
    // topology cache in place rather than replacing it with an empty map.
    collectTopology().then((data) => writeCache(bucketName, TOPOLOGY_CACHE_S3_KEY, data)),
  ]);

  if (infraResult.status === 'rejected') {
    logger.error('infra-collector: getInfraData/writeCache failed (keeping old infra cache)', infraResult.reason);
  }
  if (complianceResult.status === 'rejected') {
    logger.error('infra-collector: getComplianceData/writeCache failed (keeping old compliance cache)', complianceResult.reason);
  }
  if (topologyResult.status === 'rejected') {
    logger.error('infra-collector: collectTopology/writeCache failed (keeping old topology cache)', topologyResult.reason);
  }

  logger.info(
    `infra-collector: infra=${infraResult.status === 'fulfilled' ? 'ok' : 'error (keeping old cache)'} compliance=${
      complianceResult.status === 'fulfilled' ? 'ok' : 'error (keeping old cache)'
    } topology=${topologyResult.status === 'fulfilled' ? 'ok' : 'error (keeping old cache)'}`,
  );
  return { ok: true };
}
