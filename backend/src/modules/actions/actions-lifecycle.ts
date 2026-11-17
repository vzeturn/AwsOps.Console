import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from 'aws-lambda';
import { InvokeCommand } from '@aws-sdk/client-lambda';
import { getLambdaClient } from '../../core/aws-clients.js';
import { isLifecycleActionType } from '@ops-dashboard/shared';
import type { ActionExecutionRequest, ActionExecutionResult, ActionType } from '@ops-dashboard/shared';
import { ok } from '../../shared-kernel/response.js';
import { badRequest, badGateway, forbidden } from '../../shared-kernel/errors.js';
import { config } from '../../config.js';
import { isOperatorMember } from '../web/index.js';

const lambdaClient = getLambdaClient();

interface ActionLifecycleBody {
  actionType?: unknown;
  resourceId?: unknown;
  region?: unknown;
  params?: unknown;
}

function parseBody(event: LambdaFunctionURLEvent): ActionLifecycleBody {
  try {
    return JSON.parse(event.body ?? '{}') as ActionLifecycleBody;
  } catch {
    throw badRequest('Invalid JSON body');
  }
}

/** Same `resolveExecutedBy()` logic as `actions-execute.ts` — prefer email, fall back to `sub`. */
function resolveExecutedBy(claims: Record<string, unknown>): string {
  if (typeof claims.preferred_username === 'string' && claims.preferred_username.length > 0) {
    return claims.preferred_username;
  }
  return typeof claims.sub === 'string' ? claims.sub : '';
}

/**
 * `POST /actions/lifecycle` — gated SEPARATELY by `isOperatorMember()`, accepts only the 4 resource
 * lifecycle actionTypes, then forwards to the SAME `ActionExecutionFunction` that `actions-execute.ts`
 * uses — execution/audit still share a single mutating Lambda, only the router's entry point/gate
 * differs.
 */
export async function handler(
  event: LambdaFunctionURLEvent,
  claims: Record<string, unknown>,
): Promise<LambdaFunctionURLResult> {
  if (!isOperatorMember(claims)) {
    throw forbidden('Account is not a member of the operator group required to perform lifecycle actions');
  }

  const body = parseBody(event);

  // `LIFECYCLE_ACTION_TYPES` (shared) is the single source of truth, shared with `actions-execute.ts`
  // (blocks) and `actions-preview.ts` (operator gate) — these 3 places cannot drift apart.
  if (typeof body.actionType !== 'string' || !isLifecycleActionType(body.actionType)) {
    throw badRequest('Missing or invalid: actionType (only EC2_Reboot/RDS_Reboot/RDS_Start/RDS_Stop are accepted)');
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
