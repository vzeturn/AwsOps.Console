import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from 'aws-lambda';
import { InvokeCommand } from '@aws-sdk/client-lambda';
import { getLambdaClient } from '../../core/aws-clients.js';
import { ACTION_CATALOG, isOperatorOnlyActionType, isApprovalRequiredActionType } from '@ops-dashboard/shared';
import type { ActionExecutionRequest, ActionExecutionResult, ActionType } from '@ops-dashboard/shared';
import { ok } from '../../shared-kernel/response.js';
import { badRequest, badGateway } from '../../shared-kernel/errors.js';
import { config } from '../../config.js';
import { getCorrelationId } from '../../shared-kernel/logger.js';

const lambdaClient = getLambdaClient();

interface ActionExecuteBody {
  actionType?: unknown;
  resourceId?: unknown;
  region?: unknown;
  params?: unknown;
}

function parseBody(event: LambdaFunctionURLEvent): ActionExecuteBody {
  try {
    return JSON.parse(event.body ?? '{}') as ActionExecuteBody;
  } catch {
    throw badRequest('Invalid JSON body');
  }
}

/** Prefer email (more readable, Requirement 6.1) — fall back to `sub` when the claim has no
 * `preferred_username` as a string (same pattern as `me.ts`). */
function resolveExecutedBy(claims: Record<string, unknown>): string {
  if (typeof claims.preferred_username === 'string' && claims.preferred_username.length > 0) {
    return claims.preferred_username;
  }
  return typeof claims.sub === 'string' ? claims.sub : '';
}

/**
 * `POST /actions/execute` — validates the minimal body, attaches `executedBy` from the verified JWT
 * claim, and makes a synchronous (`RequestResponse`) `lambda:InvokeFunction` call to
 * `ActionExecutionFunction`. The router (`RouterRole`) does NOT call any AWS mutating API itself —
 * all execution logic lives in `action-execution-fn` (Task 4-5); this handler only forwards the
 * request/response (Requirement 6.1, 9.1).
 */
export async function handler(
  event: LambdaFunctionURLEvent,
  claims: Record<string, unknown>,
): Promise<LambdaFunctionURLResult> {
  const body = parseBody(event);

  if (typeof body.actionType !== 'string' || !ACTION_CATALOG.some((entry) => entry.actionType === body.actionType)) {
    throw badRequest('Missing or invalid: actionType');
  }
  // This endpoint is gated ONLY by `allowedGroupIds` (the general sign-in gate). Operator-only
  // actions (resource lifecycle → `POST /actions/lifecycle`; Security Group →
  // `POST /actions/security-group`) have their OWN `operatorGroupIds` gate — accepting them here
  // would make that gate meaningless (any signed-in account could reboot EC2 or open port 22 to the
  // Internet with a single request to this endpoint).
  // Block outright, with NO silent redirect. The predicate uses `isOperatorOnlyActionType` (shared)
  // so that when a new family of operator-only actions is added, this check blocks it automatically
  // without anyone having to remember to update it here.
  if (isOperatorOnlyActionType(body.actionType)) {
    throw badRequest(
      'This action requires operator permission — call POST /actions/lifecycle (resource lifecycle) or POST /actions/security-group (Security Group) instead',
    );
  }
  // Maker-checker gate (Requirement: segregation of duties for irreversible/operator-only
  // actions — see shared/src/approval.ts). isApprovalRequiredActionType() already returns true
  // for every isOperatorOnlyActionType() case (checked above, so this specific branch is only
  // ever reached for an IRREVERSIBLE-but-NOT-operator-only actionType, e.g. ElasticIp_Release,
  // Snapshot_And_Delete_EBS_Volume) — without this check, such an action could bypass the
  // approval workflow entirely via this direct-execute endpoint, defeating the whole point of
  // requiring a second person's sign-off before it runs.
  if (isApprovalRequiredActionType(body.actionType)) {
    throw badRequest(
      `actionType '${body.actionType}' requires maker-checker approval — call POST /actions/request-approval, then POST /actions/execute-approval once approved`,
    );
  }
  if (typeof body.resourceId !== 'string' || body.resourceId.length === 0) {
    throw badRequest('Missing or invalid: resourceId');
  }
  const region = typeof body.region === 'string' && body.region.length > 0 ? body.region : config.awsRegion;
  const params =
    typeof body.params === 'object' && body.params !== null && !Array.isArray(body.params)
      ? (body.params as Record<string, string | number>)
      : {};

  const request: ActionExecutionRequest = {
    actionType: body.actionType as ActionType,
    resourceId: body.resourceId,
    region,
    params,
    executedBy: resolveExecutedBy(claims),
    // Reuses the SAME id `router.ts` already set for this invocation (see
    // lib/logger.ts::setCorrelationId) — NOT a freshly generated one, so action-execution-fn's
    // logs and the resulting Action_Audit_Record can be traced back to this exact request.
    correlationId: getCorrelationId(),
  };

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

  const result = JSON.parse(payloadText) as ActionExecutionResult;
  return ok(event, result);
}
