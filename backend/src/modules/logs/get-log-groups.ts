import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from 'aws-lambda';
import { ok } from '../../shared-kernel/response.js';
import { listLogGroups } from './cloudwatch-logs-viewer-service.js';

/**
 * `GET /logs/groups` — takes no parameters. Filtering by name is client-side: AWS's
 * `logGroupNamePrefix` only matches a PREFIX, which is useless when the user only remembers the
 * middle of a name (`/aws/lambda/abc-ops-dashboard-...` → typing "ops"), so there's no point
 * declaring a parameter the UI would never send.
 */
export async function handler(event: LambdaFunctionURLEvent): Promise<LambdaFunctionURLResult> {
  return ok(event, await listLogGroups());
}
