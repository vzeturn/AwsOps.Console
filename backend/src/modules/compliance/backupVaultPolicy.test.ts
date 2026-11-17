import { describe, it, expect } from 'vitest';
import { policyHasDeletionProtection, buildProtectedVaultAccessPolicy, BACKUP_VAULT_PROTECTION_STATEMENT_SID } from './backupVaultPolicy.js';

const ACCOUNT_ID = '123456789012';

describe('policyHasDeletionProtection', () => {
  it('policy has a Deny statement with both required actions -> true', () => {
    const policy = JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'DenyDelete',
          Effect: 'Deny',
          Principal: '*',
          Action: ['backup:DeleteRecoveryPoint', 'backup:UpdateRecoveryPointLifecycle'],
          Resource: '*',
        },
      ],
    });
    expect(policyHasDeletionProtection(policy)).toBe(true);
  });

  it('policy undefined (vault has no access policy) -> false', () => {
    expect(policyHasDeletionProtection(undefined)).toBe(false);
  });

  it('policy JSON is unparseable -> false', () => {
    expect(policyHasDeletionProtection('{not valid json')).toBe(false);
  });

  it('policy has a Deny statement but is missing one of the 2 required actions -> false', () => {
    const policy = JSON.stringify({
      Version: '2012-10-17',
      Statement: [{ Effect: 'Deny', Principal: '*', Action: ['backup:DeleteRecoveryPoint'], Resource: '*' }],
    });
    expect(policyHasDeletionProtection(policy)).toBe(false);
  });

  it('policy has an Allow statement (not Deny) containing both actions -> false', () => {
    const policy = JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        { Effect: 'Allow', Principal: '*', Action: ['backup:DeleteRecoveryPoint', 'backup:UpdateRecoveryPointLifecycle'], Resource: '*' },
      ],
    });
    expect(policyHasDeletionProtection(policy)).toBe(false);
  });

  it('Statement as a single object (not an array) is still handled correctly', () => {
    const policy = JSON.stringify({
      Version: '2012-10-17',
      Statement: { Effect: 'Deny', Principal: '*', Action: ['backup:DeleteRecoveryPoint', 'backup:UpdateRecoveryPointLifecycle'], Resource: '*' },
    });
    expect(policyHasDeletionProtection(policy)).toBe(true);
  });

  it('Action as a single string (not an array) is still handled correctly when it does NOT have both actions', () => {
    const policy = JSON.stringify({
      Version: '2012-10-17',
      Statement: [{ Effect: 'Deny', Principal: '*', Action: 'backup:DeleteRecoveryPoint', Resource: '*' }],
    });
    expect(policyHasDeletionProtection(policy)).toBe(false);
  });
});

describe('buildProtectedVaultAccessPolicy', () => {
  it('vault has no policy at all (existingPolicy=undefined) -> creates a new policy with only the protection statement', () => {
    const result = buildProtectedVaultAccessPolicy(undefined, ACCOUNT_ID);
    const parsed = JSON.parse(result);

    expect(parsed.Version).toBe('2012-10-17');
    expect(parsed.Statement).toHaveLength(1);
    expect(parsed.Statement[0].Sid).toBe(BACKUP_VAULT_PROTECTION_STATEMENT_SID);
    expect(parsed.Statement[0].Effect).toBe('Deny');
    expect(parsed.Statement[0].Action).toEqual([
      'backup:DeleteRecoveryPoint',
      'backup:UpdateRecoveryPointLifecycle',
      'backup:PutBackupVaultAccessPolicy',
      'backup:DeleteBackupVaultAccessPolicy',
    ]);
    expect(parsed.Statement[0].Condition.StringNotLike['aws:PrincipalArn']).toEqual([
      `arn:aws:iam::${ACCOUNT_ID}:root`,
      `arn:aws:iam::${ACCOUNT_ID}:role/aws-service-role/backup.amazonaws.com/AWSServiceRoleForBackup`,
    ]);

    // The resulting policy MUST itself pass policyHasDeletionProtection() — otherwise the action
    // that just executed would IMMEDIATELY be flagged by the collector as "unprotected" again on
    // the next survey.
    expect(policyHasDeletionProtection(result)).toBe(true);
  });

  it('vault ALREADY has a different statement (its own purpose, not the protection statement) -> KEEPS that statement, only adds the new protection statement', () => {
    const existingPolicy = JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        { Sid: 'SomeOtherRestriction', Effect: 'Deny', Principal: '*', Action: ['backup:StartRestoreJob'], Resource: '*' },
      ],
    });

    const result = buildProtectedVaultAccessPolicy(existingPolicy, ACCOUNT_ID);
    const parsed = JSON.parse(result);

    expect(parsed.Statement).toHaveLength(2);
    expect(parsed.Statement.some((s: { Sid?: string }) => s.Sid === 'SomeOtherRestriction')).toBe(true);
    expect(parsed.Statement.some((s: { Sid?: string }) => s.Sid === BACKUP_VAULT_PROTECTION_STATEMENT_SID)).toBe(true);
  });

  it('vault already has an OLD protection statement (matching Sid) -> REPLACES it (not duplicated)', () => {
    const existingPolicy = JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        {
          Sid: BACKUP_VAULT_PROTECTION_STATEMENT_SID,
          Effect: 'Deny',
          Principal: '*',
          Action: ['backup:DeleteRecoveryPoint'], // old policy, missing an action -> will be replaced with the full version
          Resource: '*',
        },
      ],
    });

    const result = buildProtectedVaultAccessPolicy(existingPolicy, ACCOUNT_ID);
    const parsed = JSON.parse(result);

    expect(parsed.Statement).toHaveLength(1);
    expect(parsed.Statement[0].Action).toContain('backup:UpdateRecoveryPointLifecycle');
  });

  it('existingPolicy is invalid JSON -> still produces a valid new policy (no throw, no leftover garbage)', () => {
    const result = buildProtectedVaultAccessPolicy('{not valid json', ACCOUNT_ID);
    const parsed = JSON.parse(result);

    expect(parsed.Statement).toHaveLength(1);
    expect(policyHasDeletionProtection(result)).toBe(true);
  });
});
