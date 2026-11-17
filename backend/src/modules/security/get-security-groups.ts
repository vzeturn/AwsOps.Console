import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from 'aws-lambda';
import { ok } from '../../shared-kernel/response.js';
import { listSecurityGroups } from './security-group-service.js';

/**
 * `GET /security-groups` — takes no parameters, needs no operator permission: READING Security
 * Group configuration is something any signed-in user may need to diagnose a network issue, and
 * this same data is already visible in the AWS Console to anyone with read access. The operator
 * gate applies only to `POST /actions/security-group` (mutate) and its preview.
 */
export async function handler(event: LambdaFunctionURLEvent): Promise<LambdaFunctionURLResult> {
  return ok(event, await listSecurityGroups());
}
