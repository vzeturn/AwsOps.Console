import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from 'aws-lambda';
import { InvokeCommand } from '@aws-sdk/client-lambda';
import { getLambdaClient } from '../../core/aws-clients.js';
import { isApprovalStillValid } from '@ops-dashboard/shared';
import type { ActionExecutionRequest, ActionExecutionResult } from '@ops-dashboard/shared';
import type { MarkExecutedApprovalMutateEvent } from './approval-mutate-handler.js';
import type { ApprovalMutateResult } from './approval-service.js';
import { getApproval } from './approval-service.js';
import { ok } from '../../shared-kernel/response.js';
import { badRequest, badGateway, forbidden } from '../../shared-kernel/errors.js';
import { config } from '../../config.js';
import { getCorrelationId } from '../../shared-kernel/logger.js';

const lambdaClient = getLambdaClient();

interface ActionExecuteApprovalBody {
  id?: unknown;
}

function parseBody(event: LambdaFunctionURLEvent): ActionExecuteApprovalBody {
  try {
    return JSON.parse(event.body ?? '{}') as ActionExecuteApprovalBody;
  } catch {
    throw badRequest('Invalid JSON body');
  }
}

function resolveIdentity(claims: Record<string, unknown>): string {
  if (typeof claims.preferred_username === 'string' && claims.preferred_username.length > 0) {
    return claims.preferred_username;
  }
  return typeof claims.sub === 'string' ? claims.sub : '';
}

async function invokeActionExecution(request: ActionExecutionRequest): Promise<ActionExecutionResult> {
  let payloadText: string;
  let functionError: string | undefined;
  try {
    const response = await lambdaClient.send(
      new InvokeCommand({
        FunctionName: config.actionExecutionFunctionName,
        InvocationType: 'RequestResponse',
        Payload: Buffer.from(JSON.stringify(request)),
      }),
    );
    payloadText = Buffer.from(response.Payload ?? new Uint8Array()).toString('utf-8');
    functionError = response.FunctionError;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    throw badGateway(`Failed to invoke action-execution-fn: ${message}`);
  }
  if (functionError) {
    throw badGateway('action-execution-fn threw an unhandled error');
  }
  return JSON.parse(payloadText) as ActionExecutionResult;
}

async function invokeMarkExecuted(id: string): Promise<void> {
  const mutateEvent: MarkExecutedApprovalMutateEvent = { kind: 'mark-executed', id };
  try {
    const response = await lambdaClient.send(
      new InvokeCommand({
        FunctionName: config.approvalMutateFunctionName,
        InvocationType: 'RequestResponse',
        Payload: Buffer.from(JSON.stringify(mutateEvent)),
      }),
    );
    const payloadText = Buffer.from(response.Payload ?? new Uint8Array()).toString('utf-8');
    const result = JSON.parse(payloadText) as ApprovalMutateResult;
    if (!result.ok) {
      // Requirement: the underlying action having ALREADY succeeded must not be undone or hidden
      // just because the bookkeeping update failed afterwards — log only, mirror
      // action-execution-handler.ts's "audit write failure never blocks the result" rule.
      throw new Error(result.error);
    }
  } catch {
    // Swallowed deliberately — see comment above. The caller has already received a correct
    // ActionExecutionResult; a failure ONLY to mark bookkeeping must not surface as an error to
    // the UI (which would incorrectly suggest the underlying action itself failed).
  }
}

/**
 * `POST /actions/execute-approval` — the maker-checker "execute" step: takes an `approved`,
 * still-valid `Approval_Request` and ACTUALLY performs the underlying action via
 * `action-execution-fn`, then marks the request `executed`. Per `shared/src/approval.ts`'s header
 * comment, EITHER the original requester OR the approver may trigger this (the two-person control
 * is already satisfied at the decide step) — enforced below by checking the caller against BOTH
 * `requestedBy` and `decidedBy`, not `isOperatorMember()` again (a non-operator requester is
 * explicitly allowed to click Execute on their OWN now-approved request).
 */
export async function handler(
  event: LambdaFunctionURLEvent,
  claims: Record<string, unknown>,
): Promise<LambdaFunctionURLResult> {
  const body = parseBody(event);
  if (typeof body.id !== 'string' || body.id.length === 0) {
    throw badRequest('Missing or invalid: id');
  }

  const approval = await getApproval(body.id);
  if (!approval) {
    throw badRequest(`Approval request not found: ${body.id}`);
  }
  if (approval.status !== 'approved') {
    throw badRequest(`Approval request ${body.id} is not approved (status=${approval.status})`);
  }
  if (!isApprovalStillValid(approval)) {
    throw badRequest(`Approval request ${body.id} has expired — request a new approval`);
  }

  const identity = resolveIdentity(claims);
  const isRequesterOrApprover =
    identity.trim().toLowerCase() === approval.requestedBy.trim().toLowerCase() ||
    (approval.decidedBy !== undefined && identity.trim().toLowerCase() === approval.decidedBy.trim().toLowerCase());
  if (!isRequesterOrApprover) {
    throw forbidden('Only the original requester or the approver may execute an approved request');
  }

  const request: ActionExecutionRequest = {
    actionType: approval.actionType,
    resourceId: approval.resourceId,
    region: approval.region,
    params: approval.params,
    executedBy: identity,
    correlationId: getCorrelationId(),
    approvalId: approval.id,
    requestedBy: approval.requestedBy,
  };

  const result = await invokeActionExecution(request);

  // Only mark 'executed' on a real success — a 'failure'/'rejected' outcome leaves the approval
  // 'approved' and still within its validity window, so the requester/approver can retry without
  // having to go through a whole new approval cycle for a transient AWS-side error.
  if (result.outcome === 'success') {
    await invokeMarkExecuted(approval.id);
  }

  return ok(event, result);
}
