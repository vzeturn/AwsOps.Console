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
  CreateRestoreTestingPlanCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'CreateRestoreTestingPlan', input })),
  CreateRestoreTestingSelectionCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'CreateRestoreTestingSelection', input })),
}));

const { executeBackupRestoreTestingCreatePlan } = await import('./backup-restore-testing-action-service.js');

beforeEach(() => {
  backupSendMock.mockReset();
});

function alreadyExistsError(): Error {
  const err = new Error('already exists');
  err.name = 'AlreadyExistsException';
  return err;
}

describe('executeBackupRestoreTestingCreatePlan', () => {
  it('fully successful: plan does not exist yet, neither selection exists yet -> creates all 3, outcome success', async () => {
    backupSendMock.mockResolvedValue({});

    const result = await executeBackupRestoreTestingCreatePlan();

    expect(result).toEqual({
      outcome: 'success',
      restoreTestingPlanName: 'abc_prod_restore_testing_plan',
      createdRestoreTestingSelectionNames: ['abc_rds_restore_test', 'abc_ec2_restore_test'],
    });
    expect(backupSendMock).toHaveBeenCalledTimes(3);
  });

  it('idempotent: the plan AND both selections already exist (AlreadyExistsException on all 3 steps) -> still outcome success', async () => {
    backupSendMock.mockRejectedValue(alreadyExistsError());

    const result = await executeBackupRestoreTestingCreatePlan();

    expect(result).toEqual({
      outcome: 'success',
      restoreTestingPlanName: 'abc_prod_restore_testing_plan',
      createdRestoreTestingSelectionNames: ['abc_rds_restore_test', 'abc_ec2_restore_test'],
    });
  });

  it('plan created successfully as new, both selections ALREADY exist (mixed case) -> still outcome success', async () => {
    backupSendMock.mockImplementation(async (command: { __type?: string }) => {
      if (command.__type === 'CreateRestoreTestingPlan') return {};
      if (command.__type === 'CreateRestoreTestingSelection') throw alreadyExistsError();
      throw new Error('unexpected');
    });

    const result = await executeBackupRestoreTestingCreatePlan();

    expect(result.outcome).toBe('success');
    expect(result.createdRestoreTestingSelectionNames).toEqual(['abc_rds_restore_test', 'abc_ec2_restore_test']);
  });

  it('CreateRestoreTestingPlan fails FOR REAL (not AlreadyExists) -> stops immediately, does NOT call CreateRestoreTestingSelection', async () => {
    backupSendMock.mockImplementation(async (command: { __type?: string }) => {
      if (command.__type === 'CreateRestoreTestingPlan') throw new Error('InvalidParameterValueException');
      throw new Error('unexpected — should not be called');
    });

    const result = await executeBackupRestoreTestingCreatePlan();

    expect(result.outcome).toBe('failure');
    expect(result.reason).toContain('InvalidParameterValueException');
    expect(backupSendMock).toHaveBeenCalledTimes(1);
  });

  it('plan created successfully, RDS selection fails FOR REAL but EC2 selection is still attempted and succeeds -> failure with the list of what was created', async () => {
    backupSendMock.mockImplementation(async (command: { __type?: string; input?: { RestoreTestingSelection?: { RestoreTestingSelectionName?: string } } }) => {
      if (command.__type === 'CreateRestoreTestingPlan') return {};
      if (command.__type === 'CreateRestoreTestingSelection') {
        const selectionName = command.input?.RestoreTestingSelection?.RestoreTestingSelectionName;
        if (selectionName === 'abc_rds_restore_test') throw new Error('ResourceNotFoundException: role not found');
        return {};
      }
      throw new Error('unexpected');
    });

    const result = await executeBackupRestoreTestingCreatePlan();

    expect(result.outcome).toBe('failure');
    expect(result.reason).toContain('abc_rds_restore_test');
    expect(result.createdRestoreTestingSelectionNames).toEqual(['abc_ec2_restore_test']);
    expect(backupSendMock).toHaveBeenCalledTimes(3); // plan + 2 selections (both are attempted)
  });

  it('both selections fail for real -> failure, createdRestoreTestingSelectionNames is empty, reason combines both errors', async () => {
    backupSendMock.mockImplementation(async (command: { __type?: string }) => {
      if (command.__type === 'CreateRestoreTestingPlan') return {};
      if (command.__type === 'CreateRestoreTestingSelection') throw new Error('AccessDenied');
      throw new Error('unexpected');
    });

    const result = await executeBackupRestoreTestingCreatePlan();

    expect(result.outcome).toBe('failure');
    expect(result.createdRestoreTestingSelectionNames).toEqual([]);
    expect(result.reason).toContain('abc_rds_restore_test');
    expect(result.reason).toContain('abc_ec2_restore_test');
  });

  it('sends the correct RestoreMetadataOverrides/ProtectedResourceArns wildcard/IamRoleArn parameters for each selection', async () => {
    const capturedInputs: { RestoreTestingSelection?: Record<string, unknown> }[] = [];
    backupSendMock.mockImplementation(async (command: { __type?: string; input?: { RestoreTestingSelection?: Record<string, unknown> } }) => {
      if (command.__type === 'CreateRestoreTestingPlan') return {};
      if (command.__type === 'CreateRestoreTestingSelection') {
        capturedInputs.push(command.input ?? {});
        return {};
      }
      throw new Error('unexpected');
    });

    await executeBackupRestoreTestingCreatePlan();

    const rdsInput = capturedInputs.find((i) => i.RestoreTestingSelection?.RestoreTestingSelectionName === 'abc_rds_restore_test');
    const ec2Input = capturedInputs.find((i) => i.RestoreTestingSelection?.RestoreTestingSelectionName === 'abc_ec2_restore_test');

    expect(rdsInput?.RestoreTestingSelection).toMatchObject({
      ProtectedResourceType: 'RDS',
      ProtectedResourceArns: ['*'],
      IamRoleArn: 'arn:aws:iam::123456789012:role/service-role/AWSBackupDefaultServiceRole',
      RestoreMetadataOverrides: { dbInstanceClass: 'db.t3.micro' },
    });
    expect(ec2Input?.RestoreTestingSelection).toMatchObject({
      ProtectedResourceType: 'EC2',
      ProtectedResourceArns: ['*'],
      IamRoleArn: 'arn:aws:iam::123456789012:role/service-role/AWSBackupDefaultServiceRole',
      RestoreMetadataOverrides: { instanceType: 't3.micro' },
    });
  });
});
