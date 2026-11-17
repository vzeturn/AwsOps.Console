import { GetObjectCommand } from '@aws-sdk/client-s3';
import type { AssessmentReport, RecommendationItem } from '@ops-dashboard/shared';
import { logger } from '../../../shared-kernel/logger.js';
import { s3, ASSESSMENT_BUCKET_NAME } from './clients.js';

/**
 * Reads `assessment-report.json` (the report from the PREVIOUS RUN, before it gets overwritten by
 * the current run) — used to diff for NEWLY arisen high-priority findings (see
 * `modules/cost/costReporting.ts`, `findNewHighPriorityFindings`), feeding the proactive Discord notify
 * (requirement: "cost optimization needs to be actioned effectively and promptly ... to avoid
 * unnecessary costs from piling up"). `NoSuchKey` (the very first run, the object never existed)
 * or any other read/parse error is treated the same as "no previous report" (empty
 * recommendations array) — does NOT throw, because this is a READ-BEFORE-WRITE step; a failure
 * here must not be allowed to block writing the new report (this Lambda's main job).
 */
export async function readPreviousRecommendations(): Promise<RecommendationItem[]> {
  try {
    const { Body } = await s3.send(new GetObjectCommand({ Bucket: ASSESSMENT_BUCKET_NAME, Key: 'assessment-report.json' }));
    const raw = await Body?.transformToString();
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Partial<AssessmentReport>;
    return Array.isArray(parsed.recommendations) ? parsed.recommendations : [];
  } catch (err) {
    logger.error(
      'infra-review-collector: failed to read the previous run\'s assessment-report.json (treating as none, not throwing — not blocking the new report write)',
      err,
    );
    return [];
  }
}
