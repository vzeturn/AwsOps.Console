import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from 'aws-lambda';
import type { ApprovalStatus } from '@ops-dashboard/shared';
import { ok } from '../../shared-kernel/response.js';
import { badRequest } from '../../shared-kernel/errors.js';
import { listApprovals } from './approval-service.js';

const VALID_STATUSES: readonly ApprovalStatus[] = ['pending', 'approved', 'rejected', 'executed', 'expired'];

function isApprovalStatus(value: string): value is ApprovalStatus {
  return VALID_STATUSES.includes(value as ApprovalStatus);
}

/**
 * `GET /actions/approvals?status=pending` — reads DIRECTLY from S3 (read-only, same pattern as
 * `actions-audit.ts`), serving the Approvals queue page (list every pending request awaiting a
 * decision) and the general Approvals history view. `status` is optional — omitted returns every
 * `Approval_Request` regardless of status.
 */
export async function handler(event: LambdaFunctionURLEvent): Promise<LambdaFunctionURLResult> {
  const status = event.queryStringParameters?.status;
  if (status !== undefined && !isApprovalStatus(status)) {
    throw badRequest(`Invalid status: ${status} (must be one of ${VALID_STATUSES.join(', ')})`);
  }

  const approvals = await listApprovals(status);
  return ok(event, approvals);
}
