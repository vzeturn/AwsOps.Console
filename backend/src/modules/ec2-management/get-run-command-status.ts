import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from 'aws-lambda';
import { ok } from '../../shared-kernel/response.js';
import { badRequest, forbidden } from '../../shared-kernel/errors.js';
import { isOperatorMember } from '../web/index.js';
import { assertInstanceInInfraCache, EC2_INSTANCE_ID_PATTERN } from './instanceInInfraCache.js';
import { getRunCommandStatus } from './ssm-run-command-status-service.js';

/** SSM's `CommandId` is a UUID v4. */
const COMMAND_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `GET /actions/run-command/{commandId}/status?instanceId=i-...`
 *
 * Gated by the same operator check as the command-submission route — NOT because this is a mutate
 * (it's read-only), but because the stdout of `tail /var/log/messages` is sensitive operational
 * data: a merely-signed-in user must not be able to read it.
 *
 * Checks instance membership in the infra cache again here so this route can't become a
 * back-door for reading the output of a command running on an instance outside the dashboard's
 * scope.
 */
export async function handler(
  event: LambdaFunctionURLEvent,
  claims: Record<string, unknown>,
  commandId: string,
): Promise<LambdaFunctionURLResult> {
  if (!isOperatorMember(claims)) {
    throw forbidden('Account is not a member of the operator group required to read SSM command output');
  }

  if (!COMMAND_ID_PATTERN.test(commandId)) {
    throw badRequest('Invalid commandId (must be a UUID issued by SSM)');
  }
  const instanceId = event.queryStringParameters?.instanceId ?? '';
  if (!EC2_INSTANCE_ID_PATTERN.test(instanceId)) {
    throw badRequest('Missing or invalid: instanceId (must be an EC2 instance id in the form i-...)');
  }
  await assertInstanceInInfraCache(instanceId);

  return ok(event, await getRunCommandStatus(commandId, instanceId));
}
