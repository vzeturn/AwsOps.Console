import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from 'aws-lambda';
import { InvokeCommand } from '@aws-sdk/client-lambda';
import { getLambdaClient } from '../../core/aws-clients.js';
import { isSecurityGroupActionType, parseSecurityGroupIngressRule, parseSecurityGroupEgressRule } from '@ops-dashboard/shared';
import type { ActionExecutionRequest, ActionExecutionResult, ActionType } from '@ops-dashboard/shared';
import { ok } from '../../shared-kernel/response.js';
import { badRequest, badGateway, forbidden } from '../../shared-kernel/errors.js';
import { config } from '../../config.js';
import { isOperatorMember } from '../web/index.js';
import { EC2_INSTANCE_ID_PATTERN } from '../ec2-management/index.js';

const lambdaClient = getLambdaClient();

interface ActionSecurityGroupBody {
  actionType?: unknown;
  resourceId?: unknown;
  region?: unknown;
  params?: unknown;
}

function parseBody(event: LambdaFunctionURLEvent): ActionSecurityGroupBody {
  try {
    return JSON.parse(event.body ?? '{}') as ActionSecurityGroupBody;
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

const SECURITY_GROUP_ID_PATTERN = /^sg-[0-9a-f]{8,17}$/;

/**
 * `POST /actions/security-group` — gated SEPARATELY via `isOperatorMember()`, accepts only the
 * Security Group actionTypes, then forwards to the SAME `ActionExecutionFunction` that
 * `actions-execute.ts` and `actions-lifecycle.ts` use: execution/audit still goes through a single
 * mutating Lambda, only the entry point/gate at the router differs.
 */
export async function handler(
  event: LambdaFunctionURLEvent,
  claims: Record<string, unknown>,
): Promise<LambdaFunctionURLResult> {
  // The operator gate happens FIRST — before even parsing the body. No side effect should occur
  // for an unauthorized caller, not even a small one like revealing "your body is malformed".
  if (!isOperatorMember(claims)) {
    throw forbidden('Account is not a member of the operator group required to manage Security Groups');
  }

  const body = parseBody(event);

  // `SECURITY_GROUP_ACTION_TYPES` (shared) is the single source of truth, shared with
  // `actions-execute.ts` (blocks via `isOperatorOnlyActionType`) and `actions-preview.ts` (operator
  // gate) — these 3 places must never drift apart.
  if (typeof body.actionType !== 'string' || !isSecurityGroupActionType(body.actionType)) {
    throw badRequest(
      'Missing or invalid: actionType (only registered Security Group actions are accepted)',
    );
  }
  // `isSecurityGroupActionType()` returns a plain `boolean` (not a type predicate) — explicitly
  // cast down to the exact 7 literals in SECURITY_GROUP_ACTION_TYPES, already confirmed by the
  // runtime check above, so the switch below can be exhaustively checked.
  const actionType = body.actionType as
    | 'SecurityGroup_AuthorizeIngress'
    | 'SecurityGroup_RevokeIngress'
    | 'SecurityGroup_AuthorizeEgress'
    | 'SecurityGroup_RevokeEgress'
    | 'Ec2_ModifySecurityGroups'
    | 'SecurityGroup_Create'
    | 'SecurityGroup_Delete';

  // SecurityGroup_Create: there is no real GroupId at request time yet (AWS only returns it AFTER
  // creation) — the client sends a fixed 'pending' placeholder, bypassing the sg-.../i-... regex.
  // See action-execution-handler.ts's `auditResourceId` for the real ARN audit AFTER execution.
  let resourceId: string;
  if (actionType === 'SecurityGroup_Create') {
    resourceId = 'pending';
  } else {
    // Ec2_ModifySecurityGroups targets a single EC2 instance (i-...), not a Security Group (sg-...)
    // — every other action targets a Security Group, sharing the sg-... pattern.
    const resourceIdPattern = actionType === 'Ec2_ModifySecurityGroups' ? EC2_INSTANCE_ID_PATTERN : SECURITY_GROUP_ID_PATTERN;
    if (typeof body.resourceId !== 'string' || !resourceIdPattern.test(body.resourceId)) {
      throw badRequest(`Missing or invalid: resourceId (must match ${resourceIdPattern})`);
    }
    resourceId = body.resourceId;
  }
  const region = typeof body.region === 'string' && body.region.length > 0 ? body.region : config.awsRegion;
  const rawParams =
    typeof body.params === 'object' && body.params !== null && !Array.isArray(body.params)
      ? (body.params as Record<string, unknown>)
      : {};

  // Validates IMMEDIATELY at the router: bad input shouldn't cost a Lambda invoke, and it gets a
  // specific error message to the UI faster. The executing services STILL validate again:
  // action-execution-fn must not assume its caller is trustworthy.
  let params: Record<string, string | number>;
  switch (actionType) {
    case 'SecurityGroup_AuthorizeIngress':
    case 'SecurityGroup_RevokeIngress': {
      const parsed = parseSecurityGroupIngressRule(rawParams);
      if (!parsed.ok) {
        throw badRequest(parsed.message);
      }
      // Sends the NORMALIZED rule rather than raw params: this way Action_Audit_Record always
      // records clean integers/strings, not the raw string straight from the form.
      params = {
        protocol: parsed.rule.protocol,
        fromPort: parsed.rule.fromPort,
        toPort: parsed.rule.toPort,
        cidrIp: parsed.rule.cidrIp,
        ...(parsed.rule.description ? { description: parsed.rule.description } : {}),
      };
      break;
    }
    case 'SecurityGroup_AuthorizeEgress':
    case 'SecurityGroup_RevokeEgress': {
      const parsed = parseSecurityGroupEgressRule(rawParams as Record<string, string>);
      if (!parsed.ok) {
        throw badRequest(parsed.message);
      }
      params = {
        protocol: parsed.rule.protocol,
        fromPort: parsed.rule.fromPort,
        toPort: parsed.rule.toPort,
        cidrIp: parsed.rule.cidrIp,
        ...(parsed.rule.description ? { description: parsed.rule.description } : {}),
      };
      break;
    }
    case 'Ec2_ModifySecurityGroups': {
      // Full groupIds validation (valid JSON, string array, non-empty) happens in
      // preview-service.ts/ec2-modify-security-groups-service.ts — the router only blocks a
      // missing param.
      if (typeof rawParams.groupIds !== 'string' || rawParams.groupIds.length === 0) {
        throw badRequest('Missing or invalid: params.groupIds (must be a JSON-encoded string[])');
      }
      params = { groupIds: rawParams.groupIds };
      break;
    }
    case 'SecurityGroup_Create': {
      if (typeof rawParams.groupName !== 'string' || !rawParams.groupName) {
        throw badRequest('Missing or invalid: params.groupName');
      }
      if (typeof rawParams.description !== 'string' || !rawParams.description) {
        throw badRequest('Missing or invalid: params.description');
      }
      if (typeof rawParams.vpcId !== 'string' || !rawParams.vpcId) {
        throw badRequest('Missing or invalid: params.vpcId');
      }
      params = { groupName: rawParams.groupName, description: rawParams.description, vpcId: rawParams.vpcId };
      break;
    }
    case 'SecurityGroup_Delete':
      params = {};
      break;
    default: {
      const _exhaustive: never = actionType;
      throw badRequest(`Internal error: unhandled actionType ${_exhaustive as string}`);
    }
  }

  const request: ActionExecutionRequest = {
    actionType: actionType as ActionType,
    resourceId,
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
