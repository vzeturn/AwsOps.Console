import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import type { MonitoringResourceType, ThresholdHistoryEntry, ThresholdLevel } from '@ops-dashboard/shared';
import { logger } from '../../shared-kernel/logger.js';
import { getS3Client } from '../../core/aws-clients.js';

/**
 * `threshold-history-service.ts` runs inside the `router` Lambda (called from
 * `monitoring-service.ts` on the handling path of every `/monitoring` request), NOT a separate
 * scheduled Lambda — but reads env directly (bypassing `config.ts`) following the same
 * independent fail-loud pattern as `infra-review-collector.ts`, so this service stays
 * self-contained and easy to test/mock without pulling in the entire `AppConfig`
 * (ENTRA_TENANT_ID, ALLOWED_ORIGINS, ...) unrelated to reading/writing threshold history.
 */
const s3 = getS3Client();

/** Reuses the same `AssessmentReportBucket` bucket (new prefix `threshold-history/`) — see
 * design.md, "Threshold_History storage decision" section. The env var name matches
 * `infra-review-collector.ts` (`ASSESSMENT_BUCKET_NAME`, granted to `RouterRole` via
 * CloudFormation). */
const ASSESSMENT_BUCKET_NAME = process.env.ASSESSMENT_BUCKET_NAME;
if (!ASSESSMENT_BUCKET_NAME) throw new Error('Missing required environment variable: ASSESSMENT_BUCKET_NAME');

/** Requirement 14.2: retain for at least 24h. S3 Lifecycle (2-day expiry) is an independent
 * backstop cleanup layer — this is the application-side filter, a safety margin below the
 * lifecycle threshold. */
const RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * Shape stored in S3 (`threshold-history/{resourceType}-{resourceId}.json`). `lastLevels` matches
 * the example in design.md (Architecture) exactly. `lastValues` is an addition (not present in
 * the design's illustrative example, which was only meant as an illustration) — needed so
 * `recordIfChanged()` knows the "previous measured value" (Requirement 14.1) when comparing on
 * the next cycle, since `lastLevels` only holds `Threshold_Level`, not the measured value.
 */
interface ThresholdHistoryStore {
  lastLevels: Record<string, ThresholdLevel>;
  lastValues: Record<string, number>;
  history: ThresholdHistoryEntry[];
}

/** Creates a `Record<string, T>` with a `null` prototype (doesn't inherit `Object.prototype`) —
 * required because `metric` is an untrusted string (comes from measured/CloudWatch data), and
 * looking up `obj[metric]` on a plain object literal ({}) would return an inherited function
 * (e.g. "toString", "constructor", "hasOwnProperty", "valueOf") instead of `undefined` when
 * `metric` collides with a property name inherited from `Object.prototype` — corrupting
 * `previousLevel !== undefined` on the very first evaluation. */
function safeRecord<T>(source?: Record<string, T> | null): Record<string, T> {
  return Object.assign(Object.create(null) as Record<string, T>, source ?? {});
}

function emptyStore(): ThresholdHistoryStore {
  return { lastLevels: safeRecord(), lastValues: safeRecord(), history: [] };
}

function objectKey(resourceType: MonitoringResourceType, resourceId: string): string {
  return `threshold-history/${resourceType}-${resourceId}.json`;
}

/** Filters out entries older than 24h (Requirement 14.2), used both when writing (Task 6.1) and
 * when reading (Task getHistory) — ensures an entry past its minimum retention is never
 * returned/kept. */
function pruneExpired(history: ThresholdHistoryEntry[], nowMs: number): ThresholdHistoryEntry[] {
  return history.filter((entry) => nowMs - new Date(entry.timestamp).getTime() < RETENTION_MS);
}

/**
 * Reads 1 resource's threshold history object. `NoSuchKey` (a new resource, never had history
 * written) or any other read/parse error is treated as empty — per the "never throw" requirement
 * from Design Error Handling (history is a Group D supporting feature, must not block the main
 * Realtime_Metric).
 */
async function readStore(
  resourceType: MonitoringResourceType,
  resourceId: string,
): Promise<ThresholdHistoryStore> {
  try {
    const { Body } = await s3.send(
      new GetObjectCommand({ Bucket: ASSESSMENT_BUCKET_NAME, Key: objectKey(resourceType, resourceId) }),
    );
    const raw = await Body?.transformToString();
    if (!raw) return emptyStore();

    const parsed = JSON.parse(raw) as Partial<ThresholdHistoryStore>;
    return {
      lastLevels: safeRecord(parsed.lastLevels),
      lastValues: safeRecord(parsed.lastValues),
      history: Array.isArray(parsed.history) ? parsed.history : [],
    };
  } catch (err) {
    logger.error(
      `threshold-history-service: failed to read threshold history for ${resourceType}-${resourceId} (treating as no history, not throwing)`,
      err,
    );
    return emptyStore();
  }
}

/**
 * Compares a metric/resource's new `Threshold_Level` against the stored `lastLevels`. If
 * different (AND there was a prior evaluation — the very first evaluation only initializes the
 * baseline, it doesn't produce a "change" entry since there's no real old value/level to record),
 * appends 1 `ThresholdHistoryEntry`, prunes entries older than 24h, then PUTs it back. Does not
 * PUT when nothing changed (Requirement 14.1, Architecture).
 *
 * S3 read/write errors never throw outward — `getMonitoringData()` (Task 3.10) must not be
 * allowed to fail the `/monitoring` response just because a transient history write failed
 * (Design Error Handling).
 */
export async function recordIfChanged(
  resourceType: MonitoringResourceType,
  resourceId: string,
  metric: string,
  value: number,
  level: ThresholdLevel,
): Promise<void> {
  const store = await readStore(resourceType, resourceId);
  const previousLevel = store.lastLevels[metric];
  const previousValue = store.lastValues[metric];

  // No change from the most recent evaluation -> nothing to record, no PUT.
  if (previousLevel === level) return;

  const hadPriorEvaluation = previousLevel !== undefined;
  if (hadPriorEvaluation) {
    store.history.push({
      metric,
      timestamp: new Date().toISOString(),
      oldValue: previousValue ?? value,
      newValue: value,
      oldLevel: previousLevel,
      newLevel: level,
    });
  }

  store.lastLevels[metric] = level;
  store.lastValues[metric] = value;
  store.history = pruneExpired(store.history, Date.now());

  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: ASSESSMENT_BUCKET_NAME,
        Key: objectKey(resourceType, resourceId),
        Body: JSON.stringify({
          lastLevels: store.lastLevels,
          lastValues: store.lastValues,
          history: store.history,
        }),
        ContentType: 'application/json',
      }),
    );
  } catch (err) {
    logger.error(
      `threshold-history-service: failed to write threshold history for ${resourceType}-${resourceId} (ignoring, not failing the /monitoring response)`,
      err,
    );
  }
}

/**
 * Returns the `Threshold_Level` transition history for 1 specific metric/resource, including only
 * entries still within the 24h minimum retention window (Requirement 14.2/14.3). `NoSuchKey`/a
 * read error -> empty array, never throws.
 */
export async function getHistory(
  resourceType: MonitoringResourceType,
  resourceId: string,
  metric: string,
): Promise<ThresholdHistoryEntry[]> {
  const store = await readStore(resourceType, resourceId);
  return pruneExpired(store.history, Date.now()).filter((entry) => entry.metric === metric);
}
