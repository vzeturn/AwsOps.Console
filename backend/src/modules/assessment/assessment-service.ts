import { GetObjectCommand } from '@aws-sdk/client-s3';
import type { AssessmentReport } from '@ops-dashboard/shared';
import { config } from '../../config.js';
import { logger } from '../../shared-kernel/logger.js';
import { getS3Client } from '../../core/aws-clients.js';

const s3 = getS3Client();

const ASSESSMENT_OBJECT_KEY = 'assessment-report.json';

/** An empty but structurally valid AssessmentReport — used when the object doesn't exist yet
 * (infra-review-collector's first run) or when reading from S3 fails. `generatedAt: ''` lets
 * Dashboard_UI recognize the data isn't ready, following the same empty-fallback pattern as
 * `getCostData` in cost-service.ts. */
function emptyAssessmentReport(): AssessmentReport {
  return {
    account: '',
    region: config.awsRegion,
    periodStart: '',
    periodEnd: '',
    generatedAt: '',
    compute: { lambda: [] },
    database: {},
    networking: { natGateways: [] },
    storage: { s3Buckets: [], ebsVolumes: [] },
    savingsPlans: { coverageByService: [] },
    backup: { protectionGaps: [] },
    recommendations: [],
  };
}

/**
 * Reads the assessment report from S3 — does NOT recompute the infrastructure assessment on the
 * request path. `infra-review-collector` (a separate Lambda) is the one that actually collects/
 * assesses and writes the result to `s3://<assessmentBucketName>/assessment-report.json`; the
 * router just reads that object back (Requirement 14.2).
 */
export async function getAssessmentData(): Promise<AssessmentReport> {
  try {
    const { Body } = await s3.send(
      new GetObjectCommand({ Bucket: config.assessmentBucketName, Key: ASSESSMENT_OBJECT_KEY }),
    );
    const raw = await Body?.transformToString();
    if (!raw) throw new Error('empty');

    return JSON.parse(raw) as AssessmentReport;
  } catch (err) {
    logger.error(
      'Failed to read assessment report (infra-review-collector may never have run)',
      err,
    );
    return emptyAssessmentReport();
  }
}
