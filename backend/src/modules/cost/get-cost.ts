import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from 'aws-lambda';
import { ok } from '../../shared-kernel/response.js';
import { getCostData } from './cost-service.js';

export async function handler(event: LambdaFunctionURLEvent): Promise<LambdaFunctionURLResult> {
  const data = await getCostData();
  return ok(event, data);
}
