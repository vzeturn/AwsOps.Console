import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from 'aws-lambda';
import { InvokeCommand } from '@aws-sdk/client-lambda';
import { getLambdaClient } from '../../core/aws-clients.js';
import { isEc2ManagementActionType } from '@ops-dashboard/shared';
import type { ActionExecutionRequest, ActionExecutionResult, ActionType } from '@ops-dashboard/shared';
import { EC2_INSTANCE_ID_PATTERN } from './instanceInInfraCache.js';
import { ok } from '../../shared-kernel/response.js';
import { badRequest, badGateway, forbidden } from '../../shared-kernel/errors.js';
import { isOperatorMember } from '../web/index.js';
import { config } from '../../config.js';

const lambdaClient = getLambdaClient();

interface ActionEc2ManagementBody {
  actionType?: unknown;
  resourceId?: unknown;
  region?: unknown;
  params?: unknown;
}

function parseBody(event: LambdaFunctionURLEvent): ActionEc2ManagementBody {
  try {
    return JSON.parse(event.body ?? '{}') as ActionEc2ManagementBody;
  } catch {
    throw badRequest('Invalid JSON body');
  }
}

/** Same `resolveExecutedBy()` logic as `actions-execute.ts`/`actions-lifecycle.ts`. */
function resolveExecutedBy(claims: Record<string, unknown>): string {
  if (typeof claims.preferred_username === 'string' && claims.preferred_username.length > 0) {
    return claims.preferred_username;
  }
  return typeof claims.sub === 'string' ? claims.sub : '';
}

/**
 * `POST /actions/ec2-management` — the SINGLE entry point for `Ec2_ChangeInstanceType`/`Ec2_UpdateTags`
 * (Section 3, 4 spec). Gates on operator BEFORE parsing the body — no information leaks to a
 * non-operator, same pattern as `actions-security-group.ts`.
 */
export async function handler(
  event: LambdaFunctionURLEvent,
  claims: Record<string, unknown>,
): Promise<LambdaFunctionURLResult> {
  if (!isOperatorMember(claims)) {
    throw forbidden('Account is not a member of the operator group required to perform this action');
  }

  const body = parseBody(event);

  if (typeof body.actionType !== 'string' || !isEc2ManagementActionType(body.actionType)) {
    throw badRequest('Missing or invalid: actionType (must be Ec2_ChangeInstanceType or Ec2_UpdateTags)');
  }
  if (typeof body.resourceId !== 'string' || !EC2_INSTANCE_ID_PATTERN.test(body.resourceId)) {
    throw badRequest('Missing or invalid: resourceId (must be an EC2 instance id)');
  }
  const region = typeof body.region === 'string' && body.region.length > 0 ? body.region : config.awsRegion;

  const rawParams =
    typeof body.params === 'object' && body.params !== null && !Array.isArray(body.params)
      ? (body.params as Record<string, unknown>)
      : {};

  // Ec2_UpdateTags sends `set`/`remove` as nested object/array — ActionExecutionRequest.params only
  // accepts a flat Record<string,string|number>, so these two fields are JSON.stringify'd before
  // forwarding. ec2-tags-action-service.ts (Task 4) JSON.parses these exact two keys back itself.
  const params: Record<string, string | number> =
    body.actionType === 'Ec2_UpdateTags'
      ? {
          set: JSON.stringify(rawParams.set ?? {}),
          remove: JSON.stringify(rawParams.remove ?? []),
        }
      : (rawParams as Record<string, string | number>);

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
