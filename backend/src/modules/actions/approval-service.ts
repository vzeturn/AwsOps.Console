import { randomUUID } from 'node:crypto';
import { GetObjectCommand, PutObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { canDecideApproval, isApprovalStillValid } from '@ops-dashboard/shared';
import type { ActionType, ApprovalRequest, ApprovalStatus } from '@ops-dashboard/shared';
import { logger } from '../../shared-kernel/logger.js';
import { getS3Client } from '../../core/aws-clients.js';

/**
 * `approval-service.ts` — S3-backed store for the maker-checker `Approval_Request` workflow (see
 * `shared/src/approval.ts` for the full rationale). Runs in BOTH `router` (read-only paths:
 * `getApproval`/`listApprovals`, serving `GET /actions/approvals` and the read-before-execute
 * check in `actions-execute-approval.ts`) AND the dedicated `approval-mutate-fn` Lambda (write
 * paths: `createApprovalRequest`/`decideApproval`/`markApprovalExecuted`) — the EXACT same
 * dual-usage pattern as `action-audit-service.ts` (see that file's header comment). Do NOT assume
 * the role calling this file only has read permission: `RouterRole` gets `s3:GetObject`/
 * `s3:ListBucket` ONLY (no `PutObject`) on the `approvals/` prefix — the write functions below are
 * only ever actually INVOKED from `approval-mutate-fn` (which holds the write IAM grant); the
 * router never calls them directly (see `handlers/actions-request-approval.ts`/
 * `actions-decide-approval.ts`, which forward via `lambda:InvokeFunction` instead).
 *
 * Reads `ASSESSMENT_BUCKET_NAME`/`AWS_REGION` DIRECTLY from the environment, bypassing `config.ts`
 * — same independent, self-contained pattern as `threshold-history-service.ts`. `config.ts`'s
 * `AppConfig` is a singleton that validates EVERY required field (Entra/StateManager/...) at
 * module load — importing it here would force `approval-mutate-fn` (a small Lambda with no need
 * for any of those) to carry a copy of every unrelated env var just to boot, exactly the class of
 * bug `lambda-boot.test.ts` exists to catch (see that file's header comment).
 *
 * Reuses the existing `AssessmentReportBucket`, prefix `approvals/`. UNLIKE `action-audit-service.ts`
 * (1 independent, never-modified object per record), an `Approval_Request` genuinely needs
 * read-modify-write: `pending` -> `approved`/`rejected` -> `executed` are all the SAME record
 * evolving over time, so it's stored as exactly 1 S3 object per request (`approvals/{id}.json`),
 * overwritten in place on each transition — the same read-modify-write shape as
 * `threshold-history-service.ts`, just without that file's history-array/pruning complexity (an
 * approval request has no need to retain prior states, only its current one).
 */
const s3 = getS3Client();

const ASSESSMENT_BUCKET_NAME = process.env.ASSESSMENT_BUCKET_NAME;
if (!ASSESSMENT_BUCKET_NAME) throw new Error('Missing required environment variable: ASSESSMENT_BUCKET_NAME');

const PREFIX = 'approvals/';

function objectKey(id: string): string {
  return `${PREFIX}${id}.json`;
}

export type ApprovalMutateResult = { ok: true; approval: ApprovalRequest } | { ok: false; error: string };

export interface CreateApprovalInput {
  actionType: ActionType;
  resourceId: string;
  region: string;
  params: Record<string, string | number>;
  requestedReason: string;
  requestedBy: string;
}

async function writeApproval(approval: ApprovalRequest): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: ASSESSMENT_BUCKET_NAME,
      Key: objectKey(approval.id),
      Body: JSON.stringify(approval),
      ContentType: 'application/json',
    }),
  );
}

/**
 * Creates a brand-new `pending` `Approval_Request` (Requirement: maker-checker request step).
 * UNLIKE `action-audit-service.ts::writeAuditRecord` (fire-and-forget, never throws), a failed
 * write here IS the actual business outcome the caller (the requester, waiting on this response)
 * needs to see — so it's surfaced as `{ ok: false, error }`, not silently swallowed.
 */
export async function createApprovalRequest(input: CreateApprovalInput): Promise<ApprovalMutateResult> {
  const approval: ApprovalRequest = {
    id: randomUUID(),
    actionType: input.actionType,
    resourceId: input.resourceId,
    region: input.region,
    params: input.params,
    requestedReason: input.requestedReason,
    requestedBy: input.requestedBy,
    requestedAt: new Date().toISOString(),
    status: 'pending',
  };

  try {
    await writeApproval(approval);
    logger.info(
      `approval-service: created approval request ${approval.id} for actionType=${approval.actionType} resourceId=${approval.resourceId} requestedBy=${approval.requestedBy}`,
    );
    return { ok: true, approval };
  } catch (err) {
    logger.error(
      `approval-service: failed to write new approval request for actionType=${input.actionType} resourceId=${input.resourceId}`,
      err,
    );
    return { ok: false, error: 'Failed to create approval request' };
  }
}

/**
 * Reads exactly 1 `Approval_Request` by id. Returns `undefined` for NotFound/any read or parse
 * error — never throws. Used both by the router's single-lookup paths (`GET
 * /actions/approvals`'s underlying list, and the read-before-execute check in
 * `actions-execute-approval.ts`) and internally by `decideApproval`/`markApprovalExecuted` below
 * before writing an update.
 */
export async function getApproval(id: string): Promise<ApprovalRequest | undefined> {
  try {
    const { Body } = await s3.send(new GetObjectCommand({ Bucket: ASSESSMENT_BUCKET_NAME, Key: objectKey(id) }));
    const raw = await Body?.transformToString();
    if (!raw) return undefined;
    return JSON.parse(raw) as ApprovalRequest;
  } catch (err) {
    logger.error(`approval-service: failed to read approval request ${id} (treated as not found, not throwing)`, err);
    return undefined;
  }
}

/**
 * Lists every `Approval_Request`, optionally filtered to 1 `status` (e.g. `pending`, for the
 * Approvals queue page), sorted descending by `requestedAt`. Never throws — a list/read/parse
 * failure is treated as "no records found" (same "never block the read path" convention as
 * `action-audit-service.ts::listAuditRecordsForResource`).
 */
export async function listApprovals(statusFilter?: ApprovalStatus): Promise<ApprovalRequest[]> {
  let keys: string[];
  try {
    const { Contents = [] } = await s3.send(new ListObjectsV2Command({ Bucket: ASSESSMENT_BUCKET_NAME, Prefix: PREFIX }));
    keys = Contents.map((object) => object.Key).filter((key): key is string => !!key);
  } catch (err) {
    logger.error('approval-service: failed to list approval requests (treated as no records found, not throwing)', err);
    return [];
  }

  const results: ApprovalRequest[] = [];
  for (const key of keys) {
    try {
      const { Body } = await s3.send(new GetObjectCommand({ Bucket: ASSESSMENT_BUCKET_NAME, Key: key }));
      const raw = await Body?.transformToString();
      if (!raw) continue;
      const approval = JSON.parse(raw) as ApprovalRequest;
      if (!statusFilter || approval.status === statusFilter) results.push(approval);
    } catch (err) {
      logger.error(`approval-service: failed to read/parse approval request for key=${key} (skipping this record, continuing with the others)`, err);
    }
  }

  return results.sort((a, b) => (a.requestedAt < b.requestedAt ? 1 : a.requestedAt > b.requestedAt ? -1 : 0));
}

/**
 * Decides (approves/rejects) a `pending` `Approval_Request`. Enforces the maker-checker rule
 * SERVER-SIDE (Requirement: segregation of duties) via `canDecideApproval` — a client-supplied
 * `decidedBy` claiming to be "a different person" is worthless if the check trusted it, so this
 * ALWAYS reads the stored `requestedBy` from S3 and compares against it, never trusting anything
 * the caller asserts about who requested it.
 */
export async function decideApproval(
  id: string,
  decidedBy: string,
  decision: 'approved' | 'rejected',
  decisionReason?: string,
): Promise<ApprovalMutateResult> {
  const existing = await getApproval(id);
  if (!existing) return { ok: false, error: `Approval request not found: ${id}` };
  if (existing.status !== 'pending') {
    return { ok: false, error: `Approval request ${id} is not pending (status=${existing.status})` };
  }
  if (!canDecideApproval(existing, decidedBy)) {
    return { ok: false, error: 'The requester cannot decide their own approval request' };
  }
  if (decision === 'rejected' && (!decisionReason || decisionReason.trim() === '')) {
    return { ok: false, error: 'decisionReason is required when rejecting an approval request' };
  }

  const updated: ApprovalRequest = {
    ...existing,
    status: decision,
    decidedBy,
    decidedAt: new Date().toISOString(),
    ...(decisionReason ? { decisionReason } : {}),
  };

  try {
    await writeApproval(updated);
    logger.info(`approval-service: approval request ${id} ${decision} by ${decidedBy}`);
    return { ok: true, approval: updated };
  } catch (err) {
    logger.error(`approval-service: failed to write decision for approval request ${id}`, err);
    return { ok: false, error: 'Failed to save decision' };
  }
}

/**
 * Marks an `approved` `Approval_Request` as `executed`, once the underlying action has actually
 * been carried out successfully via `action-execution-fn` (called from
 * `actions-execute-approval.ts` AFTER a successful `ActionExecutionResult`, never before). Refuses
 * if the request isn't `approved` or has passed `APPROVAL_VALID_FOR_MS` — see `isApprovalStillValid`'s
 * doc comment in `shared/src/approval.ts` for why an approval isn't a standing authorization.
 */
export async function markApprovalExecuted(id: string): Promise<ApprovalMutateResult> {
  const existing = await getApproval(id);
  if (!existing) return { ok: false, error: `Approval request not found: ${id}` };
  if (existing.status !== 'approved') {
    return { ok: false, error: `Approval request ${id} is not approved (status=${existing.status})` };
  }
  if (!isApprovalStillValid(existing)) {
    return { ok: false, error: `Approval request ${id} has expired — request a new approval` };
  }

  const updated: ApprovalRequest = { ...existing, status: 'executed', executedAt: new Date().toISOString() };
  try {
    await writeApproval(updated);
    return { ok: true, approval: updated };
  } catch (err) {
    logger.error(`approval-service: failed to mark approval request ${id} as executed`, err);
    return { ok: false, error: 'Failed to mark approval request as executed' };
  }
}
