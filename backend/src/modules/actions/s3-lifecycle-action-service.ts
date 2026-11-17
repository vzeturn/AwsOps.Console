import {
  GetBucketLifecycleConfigurationCommand,
  PutBucketLifecycleConfigurationCommand,
  type TransitionStorageClass,
} from '@aws-sdk/client-s3';
import type { ActionExecutionResult } from '@ops-dashboard/shared';
import { getS3Client } from '../../core/aws-clients.js';

/**
 * `s3-lifecycle-action-service.ts` runs inside `action-execution-fn` (a new Lambda,
 * `ActionExecutionRole` — mutating, fully separate from the read-only `RouterRole`). The client is
 * created once at module scope, following the module-level client pattern already used in
 * `infra-service.ts`.
 */
const s3 = getS3Client();

/** Amazon S3 lifecycle transition storage class — the real AWS SDK enum values
 * (`TransitionStorageClass`), NOT the display names (Standard-IA/Glacier/Glacier Deep Archive)
 * used in the UI/Confirmation_Dialog. Only these 3 values are allowed for selection by the
 * Action_Catalog (Requirement 5.1). */
export const ALLOWED_STORAGE_CLASSES: readonly TransitionStorageClass[] = ['STANDARD_IA', 'GLACIER', 'DEEP_ARCHIVE'];

const MIN_DAYS = 1;
const MAX_DAYS = 3650;

const LIFECYCLE_RULE_ID = 'ops-dashboard-lifecycle';

function isValidDays(days: number): boolean {
  return Number.isInteger(days) && days >= MIN_DAYS && days <= MAX_DAYS;
}

/**
 * Executes Apply_S3_Lifecycle_Policy (Requirement 5.1-5.4). Re-validates `days`/`storageClass`
 * here (defense-in-depth — the router/preview-service should have already validated it, but this
 * service does not blindly trust input received from another Lambda, following the principle
 * documented in `action-execution-handler.ts`).
 *
 * 1. `GetBucketLifecycleConfiguration` — if it returns >=1 existing rule, reject (don't overwrite,
 *    Requirement 5.3). `NoSuchLifecycleConfiguration` is how AWS S3 reports "no lifecycle policy
 *    yet" — treat it as 0 rules, NOT an error. Any other error (network, NoSuchBucket,
 *    throttling...) -> 'failure', do NOT call Put (Requirement 5.4).
 * 2. Only when step 1 confirms 0 existing rules -> `PutBucketLifecycleConfiguration` with exactly
 *    one rule transitioning to `storageClass` after `days` days.
 */
export async function executeApplyS3LifecyclePolicy(
  bucketName: string,
  days: number,
  storageClass: string,
): Promise<ActionExecutionResult> {
  if (!isValidDays(days)) {
    return { outcome: 'rejected', reason: `Invalid number of retention days: must be an integer between ${MIN_DAYS}-${MAX_DAYS}.` };
  }
  if (!ALLOWED_STORAGE_CLASSES.includes(storageClass as TransitionStorageClass)) {
    return { outcome: 'rejected', reason: `Invalid storage class: "${storageClass}".` };
  }

  let hasExistingRules: boolean;
  try {
    const existing = await s3.send(new GetBucketLifecycleConfigurationCommand({ Bucket: bucketName }));
    hasExistingRules = (existing.Rules?.length ?? 0) > 0;
  } catch (err) {
    const errorName = (err as { name?: string; Code?: string }).name ?? (err as { Code?: string }).Code;
    if (errorName === 'NoSuchLifecycleConfiguration') {
      // Bucket has no lifecycle policy yet — this is a normal state, not an error.
      hasExistingRules = false;
    } else {
      const message = err instanceof Error ? err.message : String(err);
      return { outcome: 'failure', reason: `Failed to check the bucket's existing lifecycle policy: ${message}` };
    }
  }

  if (hasExistingRules) {
    return { outcome: 'rejected', reason: 'The bucket already has an existing lifecycle policy.' };
  }

  try {
    await s3.send(
      new PutBucketLifecycleConfigurationCommand({
        Bucket: bucketName,
        LifecycleConfiguration: {
          Rules: [
            {
              ID: LIFECYCLE_RULE_ID,
              Status: 'Enabled',
              Filter: {},
              Transitions: [{ Days: days, StorageClass: storageClass as TransitionStorageClass }],
            },
          ],
        },
      }),
    );
    return { outcome: 'success' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { outcome: 'failure', reason: `Applying the lifecycle policy failed: ${message}` };
  }
}
