import { describe, it, expect } from 'vitest';
import { ACTION_CATALOG, isOperatorOnlyActionType, type ActionType } from '@ops-dashboard/shared';
import { AGENT_AUTO_EXECUTE_ALLOWLIST, isAgentAutoExecutable } from './agentAutoExecutionPolicy.js';

describe('AGENT_AUTO_EXECUTE_ALLOWLIST', () => {
  it('is non-empty and every entry is a real ActionType in ACTION_CATALOG', () => {
    expect(AGENT_AUTO_EXECUTE_ALLOWLIST.length).toBeGreaterThan(0);
    for (const actionType of AGENT_AUTO_EXECUTE_ALLOWLIST) {
      expect(ACTION_CATALOG.some((entry) => entry.actionType === actionType)).toBe(true);
    }
  });

  it('every entry is reversible per ACTION_CATALOG (defense-in-depth precondition)', () => {
    for (const actionType of AGENT_AUTO_EXECUTE_ALLOWLIST) {
      const entry = ACTION_CATALOG.find((e) => e.actionType === actionType);
      expect(entry?.reversibilityClass).toBe('reversible');
    }
  });

  it('no entry is an operator-only action type (defense-in-depth precondition)', () => {
    for (const actionType of AGENT_AUTO_EXECUTE_ALLOWLIST) {
      expect(isOperatorOnlyActionType(actionType)).toBe(false);
    }
  });
});

describe('isAgentAutoExecutable', () => {
  it('returns true for every allowlisted action', () => {
    for (const actionType of AGENT_AUTO_EXECUTE_ALLOWLIST) {
      expect(isAgentAutoExecutable(actionType)).toBe(true);
    }
  });

  it('returns false for every irreversible action, even if hypothetically added to the allowlist', () => {
    const irreversible = ACTION_CATALOG.filter((e) => e.reversibilityClass === 'irreversible').map((e) => e.actionType);
    expect(irreversible.length).toBeGreaterThan(0);
    for (const actionType of irreversible) {
      expect(isAgentAutoExecutable(actionType)).toBe(false);
    }
  });

  it('returns false for every operator-only action type', () => {
    const operatorOnly = ACTION_CATALOG.map((e) => e.actionType).filter((t) => isOperatorOnlyActionType(t));
    expect(operatorOnly.length).toBeGreaterThan(0);
    for (const actionType of operatorOnly) {
      expect(isAgentAutoExecutable(actionType)).toBe(false);
    }
  });

  it('returns false for actionTypes not in the allowlist even though reversible and not operator-only', () => {
    // EC2_Start is reversible and not operator-only, but deliberately not on the auto-execute
    // allowlist (starting an instance has real cost consequences the agent should not incur unattended).
    expect(isAgentAutoExecutable('EC2_Start' satisfies ActionType)).toBe(false);
  });

  it('returns false for an unrecognized/garbage actionType', () => {
    expect(isAgentAutoExecutable('Not_A_Real_ActionType')).toBe(false);
    expect(isAgentAutoExecutable('')).toBe(false);
  });

  it('every ActionType in ACTION_CATALOG is classified consistently (either safely auto-executable or explicitly not)', () => {
    // Exhaustive sweep — every known actionType must resolve without throwing.
    for (const entry of ACTION_CATALOG) {
      const result = isAgentAutoExecutable(entry.actionType);
      expect(typeof result).toBe('boolean');
    }
  });
});
