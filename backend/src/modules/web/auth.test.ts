import { describe, it, expect, vi } from 'vitest';

vi.mock('../../config.js', () => ({
  config: {
    allowedOrigins: [],
    entraTenantId: 'test-tenant',
    entraClientId: 'test-client',
    allowedGroupIds: [],
    operatorGroupIds: ['operator-group-1'],
    awsRegion: 'ap-southeast-1',
  },
}));

const { isOperatorMember } = await import('./auth.js');

describe('isOperatorMember', () => {
  it('returns true when the groups claim intersects operatorGroupIds', () => {
    expect(isOperatorMember({ groups: ['operator-group-1', 'other-group'] })).toBe(true);
  });

  it('returns false when the groups claim does not intersect operatorGroupIds', () => {
    expect(isOperatorMember({ groups: ['unrelated-group'] })).toBe(false);
  });

  it('returns false when the claim has no groups', () => {
    expect(isOperatorMember({})).toBe(false);
  });

  /**
   * I1: `assertGroupMembership()` already detected the group overage (`_claim_names` — Entra ID
   * does NOT send the `groups` claim when the account belongs to too many groups), but
   * `isOperatorMember()` had not: it only sees "no groups claim" and returns false SILENTLY. A
   * user who really is an operator loses every action button with no trace in the logs to diagnose it.
   */
  it('returns false + logs a warning when the token has group overage (_claim_names) instead of staying silent', async () => {
    vi.resetModules();
    vi.doMock('../../config.js', () => ({
      config: { entraTenantId: 'test-tenant', entraClientId: 'test-client', allowedGroupIds: [], operatorGroupIds: ['operator-group-1'] },
    }));
    const warnMock = vi.fn();
    vi.doMock('../../shared-kernel/logger.js', () => ({ logger: { warn: warnMock, info: vi.fn(), error: vi.fn() } }));
    const { isOperatorMember: isOperatorMemberOverage, hasGroupClaimOverage } = await import('./auth.js');

    expect(hasGroupClaimOverage({ _claim_names: { groups: 'src1' } })).toBe(true);
    expect(isOperatorMemberOverage({ _claim_names: { groups: 'src1' }, sub: 'user-1' })).toBe(false);
    expect(warnMock).toHaveBeenCalledTimes(1);
  });

  it('returns false when operatorGroupIds is empty (unconfigured = nobody is an operator)', async () => {
    vi.resetModules();
    vi.doMock('../../config.js', () => ({
      config: { entraTenantId: 'test-tenant', entraClientId: 'test-client', allowedGroupIds: [], operatorGroupIds: [] },
    }));
    const { isOperatorMember: isOperatorMemberWithEmptyConfig } = await import('./auth.js');
    expect(isOperatorMemberWithEmptyConfig({ groups: ['any-group'] })).toBe(false);
  });
});
