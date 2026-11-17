import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from 'aws-lambda';
import { InvokeCommand } from '@aws-sdk/client-lambda';
import { getLambdaClient } from '../../core/aws-clients.js';
import type { DecideApprovalMutateEvent } from './approval-mutate-handler.js';
import type { ApprovalMutateResult } from './approval-service.js';
import { ok } from '../../shared-kernel/response.js';
import { badRequest, badGateway, forbidden } from '../../shared-kernel/errors.js';
import { config } from '../../config.js';
import { isOperatorMember } from '../web/index.js';

const lambdaClient = getLambdaClient();

interface ActionDecideApprovalBody {
  id?: unknown;
  decision?: unknown;
  decisionReason?: unknown;
}

function parseBody(event: LambdaFunctionURLEvent): ActionDecideApprovalBody {
  try {
    return JSON.parse(event.body ?? '{}') as ActionDecideApprovalBody;
  } catch {
    throw badRequest('Invalid JSON body');
  }
}

/** Same identity-resolution logic as every other action handler. */
function resolveDecidedBy(claims: Record<string, unknown>): string {
  if (typeof claims.preferred_username === 'string' && claims.preferred_username.length > 0) {
    return claims.preferred_username;
  }
  return typeof claims.sub === 'string' ? claims.sub : '';
}

/**
 * `POST /actions/decide-approval` — the maker-checker "decide" step. Gated SEPARATELY via
 * `isOperatorMember()` (same gate as resource-lifecycle/Security Group/EC2 management actions,
 * `handlers/actions-lifecycle.ts` etc.) — the "checker" in a two-person control must be someone
 * with recognized elevated standing, not merely "any other signed-in account". This is IN ADDITION
 * to the maker!=checker identity check (`canDecideApproval`, enforced server-side inside
 * `approval-service.ts::decideApproval`, never trusting the client) — the two checks answer
 * different questions: "is this person privileged enough to approve" (this gate) vs "is this
 * person NOT the one who asked" (the service-side check).
 */
export async function handler(
  event: LambdaFunctionURLEvent,
  claims: Record<string, unknown>,
): Promise<LambdaFunctionURLResult> {
  if (!isOperatorMember(claims)) {
    throw forbidden('Account is not a member of the operator group required to decide on approval requests');
  }

  const body = parseBody(event);

  if (typeof body.id !== 'string' || body.id.length === 0) {
    throw badRequest('Missing or invalid: id');
  }
  if (body.decision !== 'approved' && body.decision !== 'rejected') {
    throw badRequest("Missing or invalid: decision (must be 'approved' or 'rejected')");
  }
  const decisionReason = typeof body.decisionReason === 'string' ? body.decisionReason.trim() : undefined;
  if (body.decision === 'rejected' && (!decisionReason || decisionReason.length === 0)) {
    throw badRequest('Missing or invalid: decisionReason (required when rejecting)');
  }

  const mutateEvent: DecideApprovalMutateEvent = {
    kind: 'decide',
    id: body.id,
    decidedBy: resolveDecidedBy(claims),
    decision: body.decision,
    ...(decisionReason ? { decisionReason } : {}),
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
    throw badRequest(result.error);
  }
  return ok(event, result.approval);
}
