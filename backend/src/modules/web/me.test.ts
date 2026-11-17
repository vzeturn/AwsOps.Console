import { describe, it, expect, vi } from 'vitest';

vi.mock('../../config.js', () => ({
  config: { allowedOrigins: [] },
  corsHeaders: () => ({}),
}));

const isOperatorMemberMock = vi.fn();
const hasGroupClaimOverageMock = vi.fn().mockReturnValue(false);
vi.mock('./auth.js', () => ({
  isOperatorMember: (claims: Record<string, unknown>) => isOperatorMemberMock(claims),
  hasGroupClaimOverage: (claims: Record<string, unknown>) => hasGroupClaimOverageMock(claims),
}));

const { handler } = await import('./me.js');

function buildEvent(): any {
  return { headers: {}, rawPath: '/me', requestContext: { http: { method: 'GET' } } };
}

describe('handler (GET /me)', () => {
  it('returns isOperator=true when isOperatorMember() returns true', async () => {
    isOperatorMemberMock.mockReturnValue(true);
    const res = await handler(buildEvent(), { sub: 'user-1', name: 'A', preferred_username: 'a@example.com', groups: ['operator-group-1'] });
    const typedResult = res as { statusCode: number; body: string };
    const body = JSON.parse(typedResult.body);
    expect(body.isOperator).toBe(true);
  });

  it('returns isOperator=false when isOperatorMember() returns false', async () => {
    isOperatorMemberMock.mockReturnValue(false);
    const res = await handler(buildEvent(), { sub: 'user-1', name: 'A' });
    const typedResult = res as { statusCode: number; body: string };
    const body = JSON.parse(typedResult.body);
    expect(body.isOperator).toBe(false);
    expect(body.operatorStatusUnknown).toBeUndefined();
  });

  // I1: when the token has group overage (`_claim_names`), there's NO way to know whether the user
  // belongs to an operator group. `/me` must say "unknown" explicitly instead of letting the UI
  // mistakenly read it as "definitely not an operator" — the field is optional so older clients aren't broken.
  it('returns operatorStatusUnknown=true when the token has group overage', async () => {
    isOperatorMemberMock.mockReturnValue(false);
    hasGroupClaimOverageMock.mockReturnValue(true);
    const res = await handler(buildEvent(), { sub: 'user-1', name: 'A', _claim_names: { groups: 'src1' } });
    const typedResult = res as { statusCode: number; body: string };
    const body = JSON.parse(typedResult.body);
    expect(body.isOperator).toBe(false);
    expect(body.operatorStatusUnknown).toBe(true);
  });
});
