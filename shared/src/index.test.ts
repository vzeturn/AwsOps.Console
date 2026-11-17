import { describe, it, expect } from 'vitest';
import {
  ACTION_CATALOG,
  isOperatorOnlyActionType,
  isEc2ManagementActionType,
  EC2_MANAGEMENT_ACTION_TYPES,
  SECURITY_GROUP_ACTION_TYPES,
  type ActionType,
  type ActionOutcome,
} from './index.js';

describe('EC2 management action types (Task 1)', () => {
  it('registers Ec2_ChangeInstanceType and Ec2_UpdateTags as operator-only', () => {
    expect(isOperatorOnlyActionType('Ec2_ChangeInstanceType')).toBe(true);
    expect(isOperatorOnlyActionType('Ec2_UpdateTags')).toBe(true);
    expect(isEc2ManagementActionType('Ec2_ChangeInstanceType')).toBe(true);
    expect(isEc2ManagementActionType('Ec2_UpdateTags')).toBe(true);
    expect(EC2_MANAGEMENT_ACTION_TYPES).toContain('Ec2_ChangeInstanceType');
    expect(EC2_MANAGEMENT_ACTION_TYPES).toContain('Ec2_UpdateTags');
  });

  it('registers all 5 new Security Group action types as operator-only', () => {
    const newSgTypes: ActionType[] = [
      'SecurityGroup_AuthorizeEgress',
      'SecurityGroup_RevokeEgress',
      'Ec2_ModifySecurityGroups',
      'SecurityGroup_Create',
      'SecurityGroup_Delete',
    ];
    for (const t of newSgTypes) {
      expect(isOperatorOnlyActionType(t)).toBe(true);
      expect(SECURITY_GROUP_ACTION_TYPES).toContain(t);
    }
  });

  it('has an ACTION_CATALOG entry for every new action type', () => {
    const newTypes: ActionType[] = [
      'Ec2_ChangeInstanceType',
      'Ec2_UpdateTags',
      'SecurityGroup_AuthorizeEgress',
      'SecurityGroup_RevokeEgress',
      'Ec2_ModifySecurityGroups',
      'SecurityGroup_Create',
      'SecurityGroup_Delete',
    ];
    for (const t of newTypes) {
      expect(ACTION_CATALOG.some((e) => e.actionType === t)).toBe(true);
    }
  });

  it('ActionOutcome accepts "partial" (type-level check via assignment)', () => {
    const outcome: ActionOutcome = 'partial';
    expect(outcome).toBe('partial');
  });
});
