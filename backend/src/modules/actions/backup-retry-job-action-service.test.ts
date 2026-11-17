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
  ListBackupJobsCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'ListBackupJobs', input })),
  StartBackupJobCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'StartBackupJob', input })),
}));

const { executeBackupRetryJob } = await import('./backup-retry-job-action-service.js');

const RESOURCE_ARN = 'arn:aws:rds:ap-southeast-1:123456789012:db:acme-rds-production-env';

beforeEach(() => {
  backupSendMock.mockReset();
});

describe('executeBackupRetryJob', () => {
  it('success: uses the vault/role from the most recent job -> StartBackupJob with the correct vault/role, returns newBackupJobId', async () => {
    let startInput: { ResourceArn?: string; BackupVaultName?: string; IamRoleArn?: string } | undefined;
    backupSendMock.mockImplementation(async (command: { __type?: string; input?: unknown }) => {
      if (command.__type === 'ListBackupJobs') {
        return {
          BackupJobs: [
            { BackupVaultName: 'ACME_Vault', IamRoleArn: 'arn:aws:iam::123456789012:role/service-role/AWSBackupDefaultServiceRole', CreationDate: new Date('2026-08-05T18:00:00Z') },
          ],
        };
      }
      if (command.__type === 'StartBackupJob') {
        startInput = command.input as typeof startInput;
        return { BackupJobId: 'new-job-123' };
      }
      throw new Error('unexpected');
    });

    const result = await executeBackupRetryJob(RESOURCE_ARN);

    expect(result).toEqual({ outcome: 'success', newBackupJobId: 'new-job-123' });
    expect(startInput).toEqual({
      ResourceArn: RESOURCE_ARN,
      BackupVaultName: 'ACME_Vault',
      IamRoleArn: 'arn:aws:iam::123456789012:role/service-role/AWSBackupDefaultServiceRole',
    });
  });

  it('picks the job with the MOST RECENT CreationDate when there are multiple jobs (independent of return order)', async () => {
    let startInput: { BackupVaultName?: string } | undefined;
    backupSendMock.mockImplementation(async (command: { __type?: string; input?: unknown }) => {
      if (command.__type === 'ListBackupJobs') {
        return {
          BackupJobs: [
            { BackupVaultName: 'OldVault', IamRoleArn: 'arn:aws:iam::123456789012:role/old', CreationDate: new Date('2026-07-01T00:00:00Z') },
            { BackupVaultName: 'NewestVault', IamRoleArn: 'arn:aws:iam::123456789012:role/newest', CreationDate: new Date('2026-08-09T00:00:00Z') },
            { BackupVaultName: 'MidVault', IamRoleArn: 'arn:aws:iam::123456789012:role/mid', CreationDate: new Date('2026-08-01T00:00:00Z') },
          ],
        };
      }
      if (command.__type === 'StartBackupJob') {
        startInput = command.input as typeof startInput;
        return { BackupJobId: 'job-x' };
      }
      throw new Error('unexpected');
    });

    await executeBackupRetryJob(RESOURCE_ARN);

    expect(startInput?.BackupVaultName).toBe('NewestVault');
  });

  it('rejected: no prior backup job for resourceArn', async () => {
    backupSendMock.mockImplementation(async (command: { __type?: string }) => {
      if (command.__type === 'ListBackupJobs') return { BackupJobs: [] };
      throw new Error('unexpected — StartBackupJob should not be called');
    });

    const result = await executeBackupRetryJob(RESOURCE_ARN);

    expect(result.outcome).toBe('rejected');
    const calledTypes = backupSendMock.mock.calls.map((c: unknown[]) => (c[0] as { __type?: string }).__type);
    expect(calledTypes).not.toContain('StartBackupJob');
  });

  it('rejected: most recent job is missing BackupVaultName/IamRoleArn -> does NOT call StartBackupJob', async () => {
    backupSendMock.mockImplementation(async (command: { __type?: string }) => {
      if (command.__type === 'ListBackupJobs') return { BackupJobs: [{ CreationDate: new Date() }] };
      throw new Error('unexpected — StartBackupJob should not be called');
    });

    const result = await executeBackupRetryJob(RESOURCE_ARN);

    expect(result.outcome).toBe('rejected');
  });

  it('failure: ListBackupJobs throws -> failure, does NOT call StartBackupJob', async () => {
    backupSendMock.mockImplementation(async (command: { __type?: string }) => {
      if (command.__type === 'ListBackupJobs') throw new Error('AccessDenied');
      throw new Error('unexpected');
    });

    const result = await executeBackupRetryJob(RESOURCE_ARN);

    expect(result.outcome).toBe('failure');
    const calledTypes = backupSendMock.mock.calls.map((c: unknown[]) => (c[0] as { __type?: string }).__type);
    expect(calledTypes).not.toContain('StartBackupJob');
  });

  it('failure: StartBackupJob throws -> failure', async () => {
    backupSendMock.mockImplementation(async (command: { __type?: string }) => {
      if (command.__type === 'ListBackupJobs') {
        return { BackupJobs: [{ BackupVaultName: 'ACME_Vault', IamRoleArn: 'arn:role', CreationDate: new Date() }] };
      }
      if (command.__type === 'StartBackupJob') throw new Error('InvalidParameterValueException');
      throw new Error('unexpected');
    });

    const result = await executeBackupRetryJob(RESOURCE_ARN);

    expect(result.outcome).toBe('failure');
    expect(result.reason).toContain('InvalidParameterValueException');
  });
});
