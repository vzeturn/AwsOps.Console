import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from 'aws-lambda';
import type { Me } from '@ops-dashboard/shared';
import { ok } from '../../shared-kernel/response.js';
import { hasGroupClaimOverage, isOperatorMember } from './auth.js';

export async function handler(
  event: LambdaFunctionURLEvent,
  claims: Record<string, unknown>,
): Promise<LambdaFunctionURLResult> {
  const me: Me = {
    sub: typeof claims.sub === 'string' ? claims.sub : '',
    name: typeof claims.name === 'string' ? claims.name : '',
    email: typeof claims.preferred_username === 'string' ? claims.preferred_username : '',
    isOperator: isOperatorMember(claims),
    // Only set when it TRULY cannot be determined — a normal token keeps the old shape (field
    // absent), so older clients aren't broken.
    ...(hasGroupClaimOverage(claims) ? { operatorStatusUnknown: true } : {}),
  };
  return ok(event, me);
}
