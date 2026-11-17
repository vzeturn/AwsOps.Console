import { randomUUID } from 'node:crypto';
import { PutObjectCommand, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { ACTION_CATALOG, type ActionAuditRecord } from '@ops-dashboard/shared';
import { config } from '../../config.js';
import { logger } from '../../shared-kernel/logger.js';
import { getS3Client } from '../../core/aws-clients.js';

/**
 * `action-audit-service.ts` runs in BOTH `action-execution-fn` (the new Lambda, writes —
 * `writeAuditRecord`) AND the `router` (reads — `listAuditRecordsForResource`, serving the
 * `GET /actions/audit` route, Task 7.3) — see design.md, "Components and Interfaces" section >
 * `backend/src/services/action-audit-service.ts`. Do NOT assume the role calling this file only
 * has mutate permissions: `RouterRole` only needs `s3:GetObject`/`s3:ListBucket` (no `PutObject`)
 * on the `action-audit/` prefix.
 *
 * Reuses the existing `AssessmentReportBucket` (via `config.assessmentBucketName`), prefix
 * `action-audit/` — per Design Decision 3: UNLIKE the read-modify-write pattern of
 * `threshold-history-service.ts`, each `Action_Audit_Record` is an INDEPENDENT S3 object
 * (`action-audit/{resourceType}-{resourceId}/{ISO8601-timestamp}-{actionId}.json`), never read
 * before writing — this fully eliminates the race condition between 2 concurrent executions on the
 * same resource. There is NO S3 Lifecycle expiration on this prefix (the audit trail is kept
 * forever).
 */
const s3 = getS3Client();

/**
 * Derives `resourceType` (used as the S3 key prefix) from `record.actionType` by looking it up in
 * `ACTION_CATALOG` — the single source of truth, avoiding the need to pass a separate
 * `resourceType` parameter (which could drift from the action's actual value). `actionType`
 * always matches exactly 1 entry because `ActionAuditRecord.actionType` is typed as `ActionType`
 * (a closed union, see `shared/src/index.ts`) — the `'unknown-resource-type'` fallback is purely
 * defensive, not the expected path.
 */
function resolveResourceTypeForKey(actionType: ActionAuditRecord['actionType']): string {
  const entry = ACTION_CATALOG.find((candidate) => candidate.actionType === actionType);
  return entry?.resourceType ?? 'unknown-resource-type';
}

function objectKeyPrefix(resourceType: string, resourceId: string): string {
  return `action-audit/${resourceType}-${resourceId}/`;
}

function objectKey(resourceType: string, resourceId: string, executedAt: string, actionId: string): string {
  return `${objectKeyPrefix(resourceType, resourceId)}${executedAt}-${actionId}.json`;
}

/**
 * Writes a new `Action_Audit_Record` to S3 — a `PutObject` of a brand-new key (encoding a random
 * `actionId` to guarantee uniqueness, since `executedAt` can collide at millisecond granularity
 * between 2 concurrent executions on the same resource), with NO prior read (Requirement 6.1, 6.2,
 * Property 10).
 *
 * Any error (including network/permission errors) is ONLY logged, NEVER thrown (Requirement 6.4,
 * Property 12, 1st line of defense — the 2nd line of defense is that the caller in
 * `action-execution-handler.ts` does not `await`-block the response on an audit write failure) —
 * the same try/catch-log-don't-throw pattern already used in `threshold-history-service.ts`
 * (`recordIfChanged`).
 */
export async function writeAuditRecord(record: ActionAuditRecord): Promise<void> {
  const resourceType = resolveResourceTypeForKey(record.actionType);
  const actionId = randomUUID();
  const key = objectKey(resourceType, record.resource.id, record.executedAt, actionId);

  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: config.assessmentBucketName,
        Key: key,
        Body: JSON.stringify(record),
        ContentType: 'application/json',
      }),
    );
  } catch (err) {
    logger.error(
      `action-audit-service: failed to write Action_Audit_Record for actionType=${record.actionType} resourceId=${record.resource.id} (key=${key}), skipping — does not block or change the execution result`,
      err,
    );
  }
}

/**
 * Reads every `Action_Audit_Record` written for a specific resource (`resourceType`-`resourceId`),
 * sorted descending by `executedAt` (Requirement 6.3, Property 11). Never throws — an error at the
 * `ListObjectsV2` step (bucket/permission) makes the whole query return empty; an error on a single
 * `GetObject`/parse (a corrupt or partially-written record) only skips that record, still
 * returning the records that could be read.
 */
export async function listAuditRecordsForResource(
  resourceType: string,
  resourceId: string,
): Promise<ActionAuditRecord[]> {
  const prefix = objectKeyPrefix(resourceType, resourceId);

  let keys: string[];
  try {
    const { Contents = [] } = await s3.send(
      new ListObjectsV2Command({ Bucket: config.assessmentBucketName, Prefix: prefix }),
    );
    keys = Contents.map((object) => object.Key).filter((key): key is string => !!key);
  } catch (err) {
    logger.error(
      `action-audit-service: failed to list Action_Audit_Record for ${resourceType}-${resourceId} (treated as no records found, does not throw)`,
      err,
    );
    return [];
  }

  const records: ActionAuditRecord[] = [];
  for (const key of keys) {
    try {
      const { Body } = await s3.send(new GetObjectCommand({ Bucket: config.assessmentBucketName, Key: key }));
      const raw = await Body?.transformToString();
      if (!raw) continue;
      records.push(JSON.parse(raw) as ActionAuditRecord);
    } catch (err) {
      logger.error(
        `action-audit-service: failed to read/parse Action_Audit_Record for key=${key} (skipping this record, continuing with the others)`,
        err,
      );
    }
  }

  return records.sort((a, b) => (a.executedAt < b.executedAt ? 1 : a.executedAt > b.executedAt ? -1 : 0));
}
