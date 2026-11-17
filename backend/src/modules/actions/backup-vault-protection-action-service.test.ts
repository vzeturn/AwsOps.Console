import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../config.js', () => ({
  config: {
    allowedOrigins: [],
    entraTenantId: 'test-tenant',
    entraClientId: 'test-client',
    allowedGroupIds: [],
    awsRegion: 'ap-southeast-1',
    costCacheParamName: 'test-cost-cache-param',
    assessmentBucketName: 'test-assessment-bucket',
    ec2StateManagerServiceTokenParamName: 'test-service-token-param',
    ec2StateManagerFunctionUrl: 'https://example.invalid/',
    actionExecutionFunctionName: 'test-action-execution-fn',
  },
  corsHeaders: () => ({}),
}));

const backupSendMock = vi.fn();

vi.mock('@aws-sdk/client-backup', () => ({
  BackupClient: vi.fn().mockImplementation(() => ({ send: backupSendMock })),
  GetBackupVaultAccessPolicyCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'GetBackupVaultAccessPolicy', input })),
  PutBackupVaultAccessPolicyCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'PutBackupVaultAccessPolicy', input })),
}));

const { executeBackupVaultApplyProtectionPolicy } = await import('./backup-vault-protection-action-service.js');

const VAULT_NAME = 'ACME_Vault';

const PROTECTED_POLICY = JSON.stringify({
  Version: '2012-10-17',
  Statement: [
    {
      Sid: 'OpsDashboardDenyDeleteAndLifecycleChangeExceptBreakGlass',
      Effect: 'Deny',
      Principal: '*',
      Action: ['backup:DeleteRecoveryPoint', 'backup:UpdateRecoveryPointLifecycle', 'backup:PutBackupVaultAccessPolicy', 'backup:DeleteBackupVaultAccessPolicy'],
      Resource: '*',
      Condition: { StringNotLike: { 'aws:PrincipalArn': ['arn:aws:iam::123456789012:root'] } },
    },
  ],
});

beforeEach(() => {
  backupSendMock.mockReset();
});

describe('executeBackupVaultApplyProtectionPolicy', () => {
  it('vault has no access policy yet (ResourceNotFoundException) -> applies a new policy, re-confirms success', async () => {
    let putCalled = false;
    backupSendMock.mockImplementation(async (command: { __type?: string }) => {
      if (command.__type === 'GetBackupVaultAccessPolicy') {
        if (!putCalled) {
          const error = new Error('no policy');
          error.name = 'ResourceNotFoundException';
          throw error;
        }
        return { Policy: PROTECTED_POLICY };
      }
      if (command.__type === 'PutBackupVaultAccessPolicy') {
        putCalled = true;
        return {};
      }
      throw new Error(`Unexpected command: ${command.__type}`);
    });

    const result = await executeBackupVaultApplyProtectionPolicy(VAULT_NAME);

    expect(result).toEqual({ outcome: 'success', protectedVaultName: VAULT_NAME });
    expect(backupSendMock).toHaveBeenCalledTimes(3); // Get (not found) -> Put -> Get (verify)
  });

  it('vault is ALREADY sufficiently protected -> idempotent, returns success IMMEDIATELY, does NOT call PutBackupVaultAccessPolicy', async () => {
    backupSendMock.mockImplementation(async (command: { __type?: string }) => {
      if (command.__type === 'GetBackupVaultAccessPolicy') return { Policy: PROTECTED_POLICY };
      throw new Error(`Unexpected command: ${command.__type}`);
    });

    const result = await executeBackupVaultApplyProtectionPolicy(VAULT_NAME);

    expect(result).toEqual({ outcome: 'success', protectedVaultName: VAULT_NAME });
    const calledTypes = backupSendMock.mock.calls.map((c: unknown[]) => (c[0] as { __type?: string }).__type);
    expect(calledTypes).not.toContain('PutBackupVaultAccessPolicy');
  });

  it('vault has a different access policy (its own purpose, not sufficiently protected) -> keeps the old statement, adds the new protection statement, PutBackupVaultAccessPolicy receives a policy with both', async () => {
    const existingOtherPolicy = JSON.stringify({
      Version: '2012-10-17',
      Statement: [{ Sid: 'SomeOtherRestriction', Effect: 'Deny', Principal: '*', Action: ['backup:StartRestoreJob'], Resource: '*' }],
    });

    let putInput: { BackupVaultName?: string; Policy?: string } | undefined;
    let getCallCount = 0;
    backupSendMock.mockImplementation(async (command: { __type?: string; input?: { BackupVaultName?: string; Policy?: string } }) => {
      if (command.__type === 'GetBackupVaultAccessPolicy') {
        getCallCount++;
        return { Policy: getCallCount === 1 ? existingOtherPolicy : PROTECTED_POLICY };
      }
      if (command.__type === 'PutBackupVaultAccessPolicy') {
        putInput = command.input;
        return {};
      }
      throw new Error(`Unexpected command: ${command.__type}`);
    });

    const result = await executeBackupVaultApplyProtectionPolicy(VAULT_NAME);

    expect(result.outcome).toBe('success');
    expect(putInput?.BackupVaultName).toBe(VAULT_NAME);
    const putPolicyParsed = JSON.parse(putInput?.Policy ?? '{}');
    expect(putPolicyParsed.Statement).toHaveLength(2);
    expect(putPolicyParsed.Statement.some((s: { Sid?: string }) => s.Sid === 'SomeOtherRestriction')).toBe(true);
  });

  it('failure: GetBackupVaultAccessPolicy throws an error OTHER THAN ResourceNotFoundException -> failure, does NOT call Put', async () => {
    backupSendMock.mockImplementation(async (command: { __type?: string }) => {
      if (command.__type === 'GetBackupVaultAccessPolicy') throw new Error('AccessDenied');
      throw new Error(`Unexpected command: ${command.__type}`);
    });

    const result = await executeBackupVaultApplyProtectionPolicy(VAULT_NAME);

    expect(result.outcome).toBe('failure');
    const calledTypes = backupSendMock.mock.calls.map((c: unknown[]) => (c[0] as { __type?: string }).__type);
    expect(calledTypes).not.toContain('PutBackupVaultAccessPolicy');
  });

  it('failure: PutBackupVaultAccessPolicy throw -> failure', async () => {
    backupSendMock.mockImplementation(async (command: { __type?: string }) => {
      if (command.__type === 'GetBackupVaultAccessPolicy') {
        const error = new Error('no policy');
        error.name = 'ResourceNotFoundException';
        throw error;
      }
      if (command.__type === 'PutBackupVaultAccessPolicy') throw new Error('MalformedPolicyDocumentException');
      throw new Error(`Unexpected command: ${command.__type}`);
    });

    const result = await executeBackupVaultApplyProtectionPolicy(VAULT_NAME);

    expect(result.outcome).toBe('failure');
    expect(result.reason).toContain('MalformedPolicyDocumentException');
  });

  it('failure: after Put succeeds, reading back COULD NOT confirm sufficient protection (verify logic fails)', async () => {
    let putCalled = false;
    backupSendMock.mockImplementation(async (command: { __type?: string }) => {
      if (command.__type === 'GetBackupVaultAccessPolicy') {
        if (!putCalled) {
          const error = new Error('no policy');
          error.name = 'ResourceNotFoundException';
          throw error;
        }
        // Reading back returns a policy that is NOT sufficiently protected (simulates an anomaly/eventual consistency case).
        return { Policy: JSON.stringify({ Version: '2012-10-17', Statement: [] }) };
      }
      if (command.__type === 'PutBackupVaultAccessPolicy') {
        putCalled = true;
        return {};
      }
      throw new Error(`Unexpected command: ${command.__type}`);
    });

    const result = await executeBackupVaultApplyProtectionPolicy(VAULT_NAME);

    expect(result.outcome).toBe('failure');
    expect(result.reason).toContain('COULD NOT confirm sufficient protection');
  });

  it('failure: Put succeeds but reading back to verify throws an error -> failure', async () => {
    let putCalled = false;
    backupSendMock.mockImplementation(async (command: { __type?: string }) => {
      if (command.__type === 'GetBackupVaultAccessPolicy') {
        if (!putCalled) {
          const error = new Error('no policy');
          error.name = 'ResourceNotFoundException';
          throw error;
        }
        throw new Error('ThrottlingException');
      }
      if (command.__type === 'PutBackupVaultAccessPolicy') {
        putCalled = true;
        return {};
      }
      throw new Error(`Unexpected command: ${command.__type}`);
    });

    const result = await executeBackupVaultApplyProtectionPolicy(VAULT_NAME);

    expect(result.outcome).toBe('failure');
    expect(result.reason).toContain('ThrottlingException');
  });
});
