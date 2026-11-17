import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from 'aws-lambda';
import type { MonitoringResourceType } from '@ops-dashboard/shared';
import { ok } from '../../shared-kernel/response.js';
import { badRequest } from '../../shared-kernel/errors.js';
import { getHistory } from './threshold-history-service.js';

const VALID_RESOURCE_TYPES: readonly MonitoringResourceType[] = ['ec2', 'rds', 'alb', 'ebs'];

export async function handler(event: LambdaFunctionURLEvent): Promise<LambdaFunctionURLResult> {
  const params = event.queryStringParameters ?? {};
  const { resourceType, resourceId, metric } = params;

  const missing: string[] = [];
  if (!resourceType) missing.push('resourceType');
  if (!resourceId) missing.push('resourceId');
  if (!metric) missing.push('metric');
  if (missing.length > 0) {
    throw badRequest(`Missing required parameter(s): ${missing.join(', ')}`);
  }

  if (!VALID_RESOURCE_TYPES.includes(resourceType as MonitoringResourceType)) {
    throw badRequest(
      `Invalid resourceType: "${resourceType}" (only ${VALID_RESOURCE_TYPES.join('/')} are accepted)`,
    );
  }

  const result = await getHistory(resourceType as MonitoringResourceType, resourceId as string, metric as string);
  return ok(event, result);
}
