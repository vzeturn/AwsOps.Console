import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from 'aws-lambda';
import type { ComplianceData } from '@ops-dashboard/shared';
import { ok } from '../../shared-kernel/response.js';
import { getComplianceData } from './compliance-service.js';
import { COMPLIANCE_CACHE_S3_KEY } from '../ec2-management/index.js';
import { readCachedJson } from '../../shared-kernel/s3Cache.js';

/** Same pattern as `get-infra.ts`: read the S3 cache first, fall back to calling AWS directly when it can't be read. */
export async function handler(event: LambdaFunctionURLEvent): Promise<LambdaFunctionURLResult> {
  const cached = await readCachedJson<ComplianceData>(COMPLIANCE_CACHE_S3_KEY);
  const data = cached ?? (await getComplianceData());
  return ok(event, data);
}
