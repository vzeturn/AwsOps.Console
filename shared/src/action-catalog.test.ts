import { describe, it, expect } from 'vitest';
import { ACTION_CATALOG, LIFECYCLE_ACTION_TYPES, isLifecycleActionType, rdsLifecycleActionsForStatus } from './index.js';
import type { ActionCatalogEntry, ActionType } from './index.js';

/**
 * **Validates: Requirements 1.1**
 * Action_Catalog must contain EXACTLY 4 types of Resource_Action: Snapshot_And_Delete_EBS_Volume,
 * Apply_S3_Lifecycle_Policy, EC2_Start, and EC2_Stop — no more, no less.
 */
describe('ACTION_CATALOG', () => {
  it('has exactly 29 entries, no more, no less', () => {
    expect(ACTION_CATALOG.length).toBe(29);
  });

  it('contains exactly the 29 actionTypes per Requirement 1.1, no other types', () => {
    const expectedActionTypes: ActionType[] = [
      'Snapshot_And_Delete_EBS_Volume',
      'Apply_S3_Lifecycle_Policy',
      'EC2_Start',
      'EC2_Stop',
      'EC2_Reboot',
      'ECS_ScaleOut',
      'RDS_IncreaseStorage',
      'RDS_Start',
      'RDS_Stop',
      'RDS_Reboot',
      'EBS_ModifyVolumeType',
      'CloudWatchLogGroup_SetRetention',
      'ElasticIp_Release',
      'EC2_Rightsize',
      'EC2_AutoRightsize',
      'BackupVault_ApplyProtectionPolicy',
      'BackupRestoreTesting_CreatePlan',
      'Backup_RetryJob',
      'RDS_ApplyResourceGovernance',
      'SecurityGroup_AuthorizeIngress',
      'SecurityGroup_RevokeIngress',
      'SSM_RunPreset',
      'Ec2_ChangeInstanceType',
      'Ec2_UpdateTags',
      'SecurityGroup_AuthorizeEgress',
      'SecurityGroup_RevokeEgress',
      'Ec2_ModifySecurityGroups',
      'SecurityGroup_Create',
      'SecurityGroup_Delete',
    ];

    expect(ACTION_CATALOG.map((entry) => entry.actionType).sort()).toEqual(
      [...expectedActionTypes].sort(),
    );
  });

  it('each entry has all 4 required fields with the correct values per the Data Models', () => {
    const expectedEntries: ActionCatalogEntry[] = [
      {
        actionType: 'Snapshot_And_Delete_EBS_Volume',
        category: 'storage',
        resourceType: 'ebs-volume',
        reversibilityClass: 'irreversible',
      },
      {
        actionType: 'Apply_S3_Lifecycle_Policy',
        category: 'storage',
        resourceType: 's3-bucket',
        reversibilityClass: 'reversible',
      },
      {
        actionType: 'EC2_Start',
        category: 'compute',
        resourceType: 'ec2-instance',
        reversibilityClass: 'reversible',
      },
      {
        actionType: 'EC2_Stop',
        category: 'compute',
        resourceType: 'ec2-instance',
        reversibilityClass: 'reversible',
      },
      {
        actionType: 'ECS_ScaleOut',
        category: 'compute',
        resourceType: 'ecs-service',
        reversibilityClass: 'reversible',
      },
      {
        actionType: 'RDS_IncreaseStorage',
        category: 'database',
        resourceType: 'rds-instance',
        reversibilityClass: 'irreversible',
      },
      {
        actionType: 'EBS_ModifyVolumeType',
        category: 'storage',
        resourceType: 'ebs-volume',
        reversibilityClass: 'reversible',
      },
      {
        actionType: 'CloudWatchLogGroup_SetRetention',
        category: 'compute',
        resourceType: 'cloudwatch-log-group',
        reversibilityClass: 'reversible',
      },
      {
        actionType: 'ElasticIp_Release',
        category: 'networking',
        resourceType: 'elastic-ip',
        reversibilityClass: 'irreversible',
      },
      {
        actionType: 'EC2_Rightsize',
        category: 'compute',
        resourceType: 'ec2-instance',
        reversibilityClass: 'reversible',
      },
      {
        actionType: 'EC2_AutoRightsize',
        category: 'compute',
        resourceType: 'ec2-instance',
        reversibilityClass: 'reversible',
      },
      {
        actionType: 'BackupVault_ApplyProtectionPolicy',
        category: 'backup',
        resourceType: 'backup-vault',
        reversibilityClass: 'reversible',
      },
      {
        actionType: 'BackupRestoreTesting_CreatePlan',
        category: 'backup',
        resourceType: 'backup-restore-testing',
        reversibilityClass: 'reversible',
      },
      {
        actionType: 'Backup_RetryJob',
        category: 'backup',
        resourceType: 'backup-job',
        reversibilityClass: 'reversible',
      },
      {
        actionType: 'RDS_ApplyResourceGovernance',
        category: 'database',
        resourceType: 'rds-instance',
        reversibilityClass: 'reversible',
      },
      {
        actionType: 'EC2_Reboot',
        category: 'compute',
        resourceType: 'ec2-instance',
        reversibilityClass: 'reversible',
      },
      {
        actionType: 'RDS_Start',
        category: 'database',
        resourceType: 'rds-instance',
        reversibilityClass: 'reversible',
      },
      {
        actionType: 'RDS_Stop',
        category: 'database',
        resourceType: 'rds-instance',
        reversibilityClass: 'reversible',
      },
      {
        actionType: 'RDS_Reboot',
        category: 'database',
        resourceType: 'rds-instance',
        reversibilityClass: 'reversible',
      },
      {
        actionType: 'SecurityGroup_AuthorizeIngress',
        category: 'networking',
        resourceType: 'security-group',
        reversibilityClass: 'reversible',
      },
      {
        actionType: 'SecurityGroup_RevokeIngress',
        category: 'networking',
        resourceType: 'security-group',
        reversibilityClass: 'reversible',
      },
      {
        actionType: 'SSM_RunPreset',
        category: 'compute',
        resourceType: 'ec2-instance',
        reversibilityClass: 'reversible',
      },
      {
        actionType: 'Ec2_ChangeInstanceType',
        category: 'compute',
        resourceType: 'ec2-instance',
        reversibilityClass: 'reversible',
      },
      {
        actionType: 'Ec2_UpdateTags',
        category: 'compute',
        resourceType: 'ec2-instance',
        reversibilityClass: 'reversible',
      },
      {
        actionType: 'SecurityGroup_AuthorizeEgress',
        category: 'networking',
        resourceType: 'security-group',
        reversibilityClass: 'reversible',
      },
      {
        actionType: 'SecurityGroup_RevokeEgress',
        category: 'networking',
        resourceType: 'security-group',
        reversibilityClass: 'reversible',
      },
      {
        actionType: 'Ec2_ModifySecurityGroups',
        category: 'networking',
        resourceType: 'ec2-instance',
        reversibilityClass: 'reversible',
      },
      {
        actionType: 'SecurityGroup_Create',
        category: 'networking',
        resourceType: 'security-group',
        reversibilityClass: 'reversible',
      },
      {
        actionType: 'SecurityGroup_Delete',
        category: 'networking',
        resourceType: 'security-group',
        reversibilityClass: 'irreversible',
      },
    ];

    for (const expected of expectedEntries) {
      const actual = ACTION_CATALOG.find((entry) => entry.actionType === expected.actionType);
      expect(actual).toEqual(expected);
    }
  });

  it('has no duplicate actionType', () => {
    const actionTypes = ACTION_CATALOG.map((entry) => entry.actionType);
    expect(new Set(actionTypes).size).toBe(actionTypes.length);
  });
});

describe('rdsLifecycleActionsForStatus', () => {
  it('allows Start when status is "stopped"', () => {
    expect(rdsLifecycleActionsForStatus('stopped')).toEqual({ canStart: true, canStop: false, canReboot: false });
  });

  it('allows Stop and Reboot when status is "available"', () => {
    expect(rdsLifecycleActionsForStatus('available')).toEqual({ canStart: false, canStop: true, canReboot: true });
  });

  it('allows no action in a transient state', () => {
    expect(rdsLifecycleActionsForStatus('modifying')).toEqual({ canStart: false, canStop: false, canReboot: false });
  });
});

describe('LIFECYCLE_ACTION_TYPES', () => {
  it('contains exactly the 4 resource lifecycle actions', () => {
    expect([...LIFECYCLE_ACTION_TYPES].sort()).toEqual(['EC2_Reboot', 'RDS_Reboot', 'RDS_Start', 'RDS_Stop']);
  });

  it('every element genuinely exists in ACTION_CATALOG', () => {
    for (const actionType of LIFECYCLE_ACTION_TYPES) {
      expect(ACTION_CATALOG.some((entry) => entry.actionType === actionType)).toBe(true);
    }
  });

  it('isLifecycleActionType correctly distinguishes lifecycle actions from regular actions', () => {
    expect(isLifecycleActionType('EC2_Reboot')).toBe(true);
    expect(isLifecycleActionType('RDS_Stop')).toBe(true);
    expect(isLifecycleActionType('EC2_Start')).toBe(false);
    expect(isLifecycleActionType('')).toBe(false);
  });
});
