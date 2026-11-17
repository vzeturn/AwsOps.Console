import type { ActionType } from '@ops-dashboard/shared';
import {
  createApprovalRequest,
  decideApproval,
  markApprovalExecuted,
  type ApprovalMutateResult,
} from './approval-service.js';
import { logger } from '../../shared-kernel/logger.js';

/**
 * `approval-mutate-fn` — dedicated mutate Lambda for the maker-checker Approval workflow, mirroring
 * `scheduled-actions-mutate-handler.ts`'s exact separation pattern: the router only reads/forwards
 * (`RouterRole` gets `s3:GetObject`/`s3:ListBucket` on `approvals/*`, for `GET /actions/approvals`),
 * and THIS Lambda is the ONLY place with `s3:PutObject` on that same prefix — required by the
 * static IAM invariant that `RouterRole` never gains a mutate/delete permission (see
 * `backend/src/__tests__/action-execution-iam-and-imports.test.ts`). Receives a typed
 * `ApprovalMutateEvent` directly from `lambda:InvokeFunction`, not an HTTP event — same as
 * `scheduled-actions-mutate-handler.ts`/`action-execution-handler.ts`.
 *
 * Does NOT itself execute the underlying AWS action once approved — `markApprovalExecuted` here
 * only flips the S3 record's status. The actual execution still goes through
 * `action-execution-fn` via `POST /actions/execute-approval` (see `handlers/actions-execute-approval.ts`),
 * a SEPARATE Lambda invocation, so an approval's S3 bookkeeping and the AWS-mutating side effect
 * never live in the same write path.
 */

export interface CreateApprovalMutateEvent {
  kind: 'create';
  actionType: ActionType;
  resourceId: string;
  region: string;
  params: Record<string, string | number>;
  requestedReason: string;
  requestedBy: string;
}

export interface DecideApprovalMutateEvent {
  kind: 'decide';
  id: string;
  decidedBy: string;
  decision: 'approved' | 'rejected';
  decisionReason?: string;
}

export interface MarkExecutedApprovalMutateEvent {
  kind: 'mark-executed';
  id: string;
}

export type ApprovalMutateEvent = CreateApprovalMutateEvent | DecideApprovalMutateEvent | MarkExecutedApprovalMutateEvent;

export async function handler(event: ApprovalMutateEvent): Promise<ApprovalMutateResult> {
  try {
    switch (event.kind) {
      case 'create':
        return await createApprovalRequest(event);
      case 'decide':
        return await decideApproval(event.id, event.decidedBy, event.decision, event.decisionReason);
      case 'mark-executed':
        return await markApprovalExecuted(event.id);
      default: {
        const _exhaustive: never = event;
        return { ok: false, error: `Internal error: unhandled kind ${(_exhaustive as ApprovalMutateEvent).kind}` };
      }
    }
  } catch (err) {
    // Any exception NOT caught by approval-service.ts's own try/catch (a real bug, not an
    // expected business outcome) — log full detail, don't leak it to the caller.
    logger.error(`approval-mutate-handler: unexpected error handling event kind=${event.kind}`, err);
    return { ok: false, error: 'Internal error' };
  }
}
