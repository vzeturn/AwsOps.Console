import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from 'aws-lambda';
import { ok } from '../../shared-kernel/response.js';
import { badRequest } from '../../shared-kernel/errors.js';
import { listAuditRecordsForResource } from './action-audit-service.js';

/**
 * `GET /actions/audit?resourceType=...&resourceId=...` — returns every `Action_Audit_Record`
 * written for a specific resource, serving Resource_Detail_Page/Recommendation_Detail_Page
 * (Requirement 6.3, 10.5). `resourceType`/`resourceId` are forwarded as-is, with no value
 * translation — they must exactly match the `ActionCatalogEntry.resourceType` string (e.g.
 * `'ec2-instance'`, `'ebs-volume'`, `'s3-bucket'`) that `writeAuditRecord` used to build the S3 key
 * prefix (`action-audit-service.ts#resolveResourceTypeForKey`), NOT the `MonitoringResourceType`
 * (`'ec2'`/`'rds'`/`'alb'`/`'ebs'`) used at `/monitoring/history`.
 */
export async function handler(event: LambdaFunctionURLEvent): Promise<LambdaFunctionURLResult> {
  const params = event.queryStringParameters ?? {};
  const { resourceType, resourceId } = params;

  const missing: string[] = [];
  if (!resourceType) missing.push('resourceType');
  if (!resourceId) missing.push('resourceId');
  if (missing.length > 0) throw badRequest(`Missing required parameter: ${missing.join(', ')}`);

  const records = await listAuditRecordsForResource(resourceType as string, resourceId as string);
  return ok(event, records);
}
