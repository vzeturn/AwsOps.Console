import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from 'aws-lambda';
import { InvokeCommand } from '@aws-sdk/client-lambda';
import { getLambdaClient } from '../../core/aws-clients.js';
import { ACTION_CATALOG, isApprovalRequiredActionType } from '@ops-dashboard/shared';
import type { ActionType } from '@ops-dashboard/shared';
import type { CreateApprovalMutateEvent } from './approval-mutate-handler.js';
import type { ApprovalMutateResult } from './approval-service.js';
import { ok } from '../../shared-kernel/response.js';
import { badRequest, badGateway } from '../../shared-kernel/errors.js';
import { config } from '../../config.js';

const lambdaClient = getLambdaClient();

interface ActionRequestApprovalBody {
  actionType?: unknown;
  resourceId?: unknown;
  region?: unknown;
  params?: unknown;
  requestedReason?: unknown;
}

function parseBody(event: LambdaFunctionURLEvent): ActionRequestApprovalBody {
  try {
    return JSON.parse(event.body ?? '{}') as ActionRequestApprovalBody;
  } catch {
    throw badRequest('Invalid JSON body');
  }
}

/** Same `resolveExecutedBy()`-shaped logic used across every other action handler — prefer email,
 * fall back to `sub`. Here the resulting identity becomes `ApprovalRequest.requestedBy`. */
function resolveRequestedBy(claims: Record<string, unknown>): string {
  if (typeof claims.preferred_username === 'string' && claims.preferred_username.length > 0) {
    return claims.preferred_username;
  }
  return typeof claims.sub === 'string' ? claims.sub : '';
}

/**
 * `POST /actions/request-approval` — the maker-checker "request" step (see `shared/src/approval.ts`
 * for the full data model/rationale). Deliberately gated ONLY by the general sign-in check
 * (`verifyEntraToken()`, already applied before this handler runs) — NOT `isOperatorMember()`.
 * This is intentional: requesting is how a NON-operator asks a DIFFERENT, privileged person to
 * review and approve an operator-only or irreversible action; the operator/segregation-of-duties
 * gate applies at the DECIDE step (`actions-decide-approval.ts`), not here. Anyone who can sign in
 * can ask; not everyone can approve.
 */
export async function handler(
  event: LambdaFunctionURLEvent,
  claims: Record<string, unknown>,
): Promise<LambdaFunctionURLResult> {
  const body = parseBody(event);

  if (typeof body.actionType !== 'string' || !ACTION_CATALOG.some((entry) => entry.actionType === body.actionType)) {
    throw badRequest('Missing or invalid: actionType');
  }
  if (!isApprovalRequiredActionType(body.actionType)) {
    throw badRequest(
      `actionType '${body.actionType}' does not require approval — use POST /actions/execute (or its operator-gated equivalent) directly`,
    );
  }
  if (typeof body.resourceId !== 'string' || body.resourceId.length === 0) {
    throw badRequest('Missing or invalid: resourceId');
  }
  if (typeof body.requestedReason !== 'string' || body.requestedReason.trim().length === 0) {
    throw badRequest('Missing or invalid: requestedReason (a maker-checker request must state why it is needed)');
  }
  const region = typeof body.region === 'string' && body.region.length > 0 ? body.region : config.awsRegion;
  const params =
    typeof body.params === 'object' && body.params !== null && !Array.isArray(body.params)
      ? (body.params as Record<string, string | number>)
      : {};

  const mutateEvent: CreateApprovalMutateEvent = {
    kind: 'create',
    actionType: body.actionType as ActionType,
    resourceId: body.resourceId,
    region,
    params,
    requestedReason: body.requestedReason.trim(),
    requestedBy: resolveRequestedBy(claims),
  };

  let payloadText: string;
  let functionError: string | undefined;
  try {
    const response = await lambdaClient.send(
      new InvokeCommand({
        FunctionName: config.approvalMutateFunctionName,
        InvocationType: 'RequestResponse',
        Payload: Buffer.from(JSON.stringify(mutateEvent)),
      }),
    );
    payloadText = Buffer.from(response.Payload ?? new Uint8Array()).toString('utf-8');
    functionError = response.FunctionError;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    throw badGateway(`Failed to invoke approval-mutate-fn: ${message}`);
  }
  if (functionError) {
    throw badGateway('approval-mutate-fn threw an unhandled error');
  }

  const result = JSON.parse(payloadText) as ApprovalMutateResult;
  if (!result.ok) {
    throw badGateway(result.error);
  }
  return ok(event, result.approval);
}
