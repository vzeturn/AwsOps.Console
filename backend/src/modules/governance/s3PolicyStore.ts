// backend/src/lib/s3PolicyStore.ts
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
// Lean_Lambda_Exception (Requirement 6.4a): direct import, not `../assessment/index.js`.
// `s3PolicyStore.ts` is used by `infra-review-collector-fn`/`time-of-day-trigger-fn` (both lean
// standalone Lambdas), and the assessment barrel also re-exports `assessment-service.ts` (which
// imports `config.ts` at module scope) — going through the barrel would make these Lambdas
// depend on env vars they are never granted (see `lambda-boot.test.ts`).
import { s3, ASSESSMENT_BUCKET_NAME } from '../assessment/infra-review-collector/clients.js';
import {
  NO_AUTO_SIZING_TAG_KEY,
  NO_AUTO_RIGHTSIZE_TAG_KEY,
  MIN_INSTANCE_TYPE_TAG_KEY,
  MAX_INSTANCE_TYPE_TAG_KEY,
  SCALE_MARGIN_PERCENT_TAG_KEY,
} from './ec2AutoRightsizing.js';
import { logger } from '../../shared-kernel/logger.js';
import type { PolicyStore } from './policyStore.js';
import type { TeamPolicyOverride, TimeOfDaySizingDecision } from './timeOfDayPolicy.js';
import type { Tag } from '@aws-sdk/client-ec2';

function scheduleKey(instanceId: string): string {
  return `timeofday-schedule/${instanceId}.json`;
}

/** First-cut `PolicyStore` implementation — reads/writes `timeofday-schedule/<instanceId>.json` in
 * `ASSESSMENT_BUCKET_NAME` (an existing bucket, following the same key convention as the current
 * `action-audit/`, `threshold-history/`). S3 errors are ONLY logged, NEVER thrown — one instance
 * failing to read/write must not block processing of other instances (following the same
 * principle as `applyAutoRightsizeTagChanges` in `rightsize-decision.ts`). */
export const s3PolicyStore: PolicyStore = {
  async getComputedSchedule(instanceId: string): Promise<TimeOfDaySizingDecision | undefined> {
    try {
      const { Body } = await s3.send(new GetObjectCommand({ Bucket: ASSESSMENT_BUCKET_NAME, Key: scheduleKey(instanceId) }));
      const text = await Body?.transformToString();
      if (!text) return undefined;
      return JSON.parse(text) as TimeOfDaySizingDecision;
    } catch (err) {
      if ((err as { name?: string }).name !== 'NoSuchKey') {
        logger.error(`s3PolicyStore: getComputedSchedule failed for ${instanceId} (ignoring, returning undefined)`, err);
      }
      return undefined;
    }
  },

  async putComputedSchedule(instanceId: string, decision: TimeOfDaySizingDecision): Promise<void> {
    try {
      await s3.send(
        new PutObjectCommand({
          Bucket: ASSESSMENT_BUCKET_NAME,
          Key: scheduleKey(instanceId),
          Body: JSON.stringify(decision),
          ContentType: 'application/json',
        }),
      );
    } catch (err) {
      logger.error(`s3PolicyStore: putComputedSchedule failed for ${instanceId} (ignoring, not throwing)`, err);
    }
  },

  async getTeamOverride(_instanceId: string, tags: Tag[]): Promise<TeamPolicyOverride> {
    const minInstanceType = tags.find((t) => t.Key === MIN_INSTANCE_TYPE_TAG_KEY)?.Value;
    const maxInstanceType = tags.find((t) => t.Key === MAX_INSTANCE_TYPE_TAG_KEY)?.Value;
    const marginRaw = tags.find((t) => t.Key === SCALE_MARGIN_PERCENT_TAG_KEY)?.Value;
    const parsedMargin = marginRaw !== undefined ? Number(marginRaw) : 0;
    const optOut = tags.some((t) => t.Key === NO_AUTO_SIZING_TAG_KEY || t.Key === NO_AUTO_RIGHTSIZE_TAG_KEY);

    return {
      scaleMarginPercent: Number.isFinite(parsedMargin) ? parsedMargin : 0,
      minInstanceType,
      maxInstanceType,
      optOut,
    };
  },
};
