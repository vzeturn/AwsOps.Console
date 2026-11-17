import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from 'aws-lambda';
import { ok } from '../../shared-kernel/response.js';
import { getAssessmentData } from './assessment-service.js';

export async function handler(event: LambdaFunctionURLEvent): Promise<LambdaFunctionURLResult> {
  const data = await getAssessmentData();
  return ok(event, data);
}
