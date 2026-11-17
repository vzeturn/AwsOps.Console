import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from 'aws-lambda';
import { InvokeCommand } from '@aws-sdk/client-lambda';
import { getLambdaClient } from '../../core/aws-clients.js';
import { findSsmRunPreset } from '@ops-dashboard/shared';
import type { ActionExecutionRequest, ActionExecutionResult } from '@ops-dashboard/shared';
import { ok } from '../../shared-kernel/response.js';
import { badRequest, badGateway, forbidden } from '../../shared-kernel/errors.js';
import { config } from '../../config.js';
import { isOperatorMember } from '../web/index.js';
import { assertInstanceInInfraCache, EC2_INSTANCE_ID_PATTERN } from './instanceInInfraCache.js';

const lambdaClient = getLambdaClient();

/**
 * The allowed body of `POST /actions/run-command` — ONLY 3 fields. There is (and must never be)
 * any field whose content gets concatenated into a shell command: no `command`, `commands`,
 * `script`, `args`, `path`, `serviceName`. Any unrecognized field in the submitted JSON is
 * completely ignored.
 */
interface ActionRunCommandBody {
  presetId?: unknown;
  instanceId?: unknown;
  region?: unknown;
}

function parseBody(event: LambdaFunctionURLEvent): ActionRunCommandBody {
  try {
    return JSON.parse(event.body ?? '{}') as ActionRunCommandBody;
  } catch {
    throw badRequest('Invalid JSON body');
  }
}

/** Same `resolveExecutedBy()` logic as `actions-security-group.ts`/`actions-lifecycle.ts`. */
function resolveExecutedBy(claims: Record<string, unknown>): string {
  if (typeof claims.preferred_username === 'string' && claims.preferred_username.length > 0) {
    return claims.preferred_username;
  }
  return typeof claims.sub === 'string' ? claims.sub : '';
}

/**
 * `POST /actions/run-command` — sends 1 READ-ONLY SSM Run Command preset to 1 EC2 instance.
 *
 * Returns `commandId` IMMEDIATELY (SendCommand is async, and Function URLs can't stream) — the
 * frontend polls `GET /actions/run-command/{commandId}/status` to get the result.
 *
 * Gated SEPARATELY by `isOperatorMember()`, then forwarded to the SAME `ActionExecutionFunction`
 * that `actions-execute.ts`/`actions-lifecycle.ts`/`actions-security-group.ts` use: everything that
 * touches infrastructure still goes through exactly 1 mutate Lambda, so auditing can't be
 * bypassed.
 */
export async function handler(
  event: LambdaFunctionURLEvent,
  claims: Record<string, unknown>,
): Promise<LambdaFunctionURLResult> {
  // The operator gate happens FIRST — before even parsing the body. No side effect should occur
  // for an unauthorized caller, not even a minor one like revealing "your body is malformed".
  if (!isOperatorMember(claims)) {
    throw forbidden('Account is not a member of the operator group required to run SSM commands');
  }

  const body = parseBody(event);

  // `presetId` is checked against a CONSTANT WHITELIST in code (`SSM_RUN_PRESETS`). This is the
  // ONLY place that determines which command will run, and it comes from source, never from the
  // request — the #1 security invariant of this sub-project.
  if (typeof body.presetId !== 'string' || !findSsmRunPreset(body.presetId)) {
    throw badRequest('Missing or invalid: presetId (must be one of the defined presets)');
  }
  if (typeof body.instanceId !== 'string' || !EC2_INSTANCE_ID_PATTERN.test(body.instanceId)) {
    throw badRequest('Missing or invalid: instanceId (must be an EC2 instance id in the form i-...)');
  }
  // Block running commands on an instance outside the dashboard's scope. MUST come before InvokeCommand.
  await assertInstanceInInfraCache(body.instanceId);

  const region = typeof body.region === 'string' && body.region.length > 0 ? body.region : config.awsRegion;

  const request: ActionExecutionRequest = {
    actionType: 'SSM_RunPreset',
    resourceId: body.instanceId,
    region,
    // ONLY `presetId` — the payload sent down to the execution layer never carries a command string.
    params: { presetId: body.presetId },
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
