import { describe, it, expect } from 'vitest';
import { ACTION_CATALOG, isOperatorOnlyActionType, getReversibilityClass } from './index.js';
import { isApprovalRequiredActionType, canDecideApproval, isApprovalStillValid, APPROVAL_VALID_FOR_MS } from './approval.js';

describe('isApprovalRequiredActionType', () => {
  it('requires approval for every irreversible actionType', () => {
    for (const entry of ACTION_CATALOG) {
      if (entry.reversibilityClass === 'irreversible') {
        expect(isApprovalRequiredActionType(entry.actionType), entry.actionType).toBe(true);
      }
    }
  });

  it('requires approval for every operator-only actionType', () => {
    for (const entry of ACTION_CATALOG) {
      if (isOperatorOnlyActionType(entry.actionType)) {
        expect(isApprovalRequiredActionType(entry.actionType), entry.actionType).toBe(true);
      }
    }
  });

  it('does NOT require approval for a reversible, non-operator-only actionType (e.g. EC2_Rightsize)', () => {
    expect(getReversibilityClass('EC2_Rightsize')).toBe('reversible');
    expect(isOperatorOnlyActionType('EC2_Rightsize')).toBe(false);
    expect(isApprovalRequiredActionType('EC2_Rightsize')).toBe(false);
  });

  it('does NOT require approval for Apply_S3_Lifecycle_Policy (reversible, non-operator-only)', () => {
    expect(isApprovalRequiredActionType('Apply_S3_Lifecycle_Policy')).toBe(false);
  });

  it('requires approval for Snapshot_And_Delete_EBS_Volume (irreversible)', () => {
    expect(isApprovalRequiredActionType('Snapshot_And_Delete_EBS_Volume')).toBe(true);
  });

  it('requires approval for EC2_Reboot (operator-only, though reversible)', () => {
    expect(getReversibilityClass('EC2_Reboot')).toBe('reversible');
    expect(isApprovalRequiredActionType('EC2_Reboot')).toBe(true);
  });

  it('requires approval for SecurityGroup_AuthorizeIngress (operator-only)', () => {
    expect(isApprovalRequiredActionType('SecurityGroup_AuthorizeIngress')).toBe(true);
  });

  it('fails closed (requires approval) for an unrecognized actionType', () => {
    expect(isApprovalRequiredActionType('Some_Made_Up_ActionType')).toBe(true);
  });
});

describe('canDecideApproval — segregation of duties', () => {
  it('returns false when the decider is the same as the requester', () => {
    expect(canDecideApproval({ requestedBy: 'alice@example.com' }, 'alice@example.com')).toBe(false);
  });

  it('returns false when the decider matches the requester with different casing', () => {
    expect(canDecideApproval({ requestedBy: 'Alice@Example.com' }, 'alice@example.com')).toBe(false);
  });

  it('returns false when the decider matches the requester with surrounding whitespace', () => {
    expect(canDecideApproval({ requestedBy: ' alice@example.com ' }, 'alice@example.com')).toBe(false);
  });

  it('returns true when the decider is a genuinely different identity', () => {
    expect(canDecideApproval({ requestedBy: 'alice@example.com' }, 'bob@example.com')).toBe(true);
  });
});

describe('isApprovalStillValid', () => {
  it('returns false when decidedAt is not set (never decided yet)', () => {
    expect(isApprovalStillValid({ decidedAt: undefined })).toBe(false);
  });

  it('returns true immediately after being decided', () => {
    const now = Date.now();
    expect(isApprovalStillValid({ decidedAt: new Date(now).toISOString() }, now)).toBe(true);
  });

  it('returns true just before the validity window expires', () => {
    const decidedAt = 1_000_000;
    const now = decidedAt + APPROVAL_VALID_FOR_MS - 1;
    expect(isApprovalStillValid({ decidedAt: new Date(decidedAt).toISOString() }, now)).toBe(true);
  });

  it('returns false once the validity window has passed', () => {
    const decidedAt = 1_000_000;
    const now = decidedAt + APPROVAL_VALID_FOR_MS + 1;
    expect(isApprovalStillValid({ decidedAt: new Date(decidedAt).toISOString() }, now)).toBe(false);
  });
});
