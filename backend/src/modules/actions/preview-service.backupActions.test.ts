import { describe, it, expect, vi, beforeEach } from 'vitest';

// Unit tests for buildActionPreviewDirect() with the 3 new backup-compliance actionTypes:
// BackupVault_ApplyProtectionPolicy/BackupRestoreTesting_CreatePlan/Backup_RetryJob — following
// the same pattern as preview-service.costOptimization.test.ts.
process.env.AWS_REGION = 'ap-southeast-1';
process.env.ASSESSMENT_BUCKET_NAME = 'test-assessment-bucket';
// preview-service.ts imports from `../governance/index.js`, whose barrel also evaluates
// `s3PolicyStore.ts` -> `assessment/infra-review-collector/clients.ts`, which reads
// AWS_ACCOUNT_ID directly from process.env at module scope (independent of the `config.js` mock
// below) and throws if missing.
process.env.AWS_ACCOUNT_ID = '123456789012';

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
  ListBackupJobsCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'ListBackupJobs', input })),
  ListRestoreTestingPlansCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'ListRestoreTestingPlans', input })),
}));

const { buildActionPreviewDirect } = await import('./preview-service.js');

beforeEach(() => {
  backupSendMock.mockReset();
});

const PROTECTED_POLICY = JSON.stringify({
  Version: '2012-10-17',
  Statement: [
    {
      Sid: 'OpsDashboardDenyDeleteAndLifecycleChangeExceptBreakGlass',
      Effect: 'Deny',
      Principal: '*',
      Action: ['backup:DeleteRecoveryPoint', 'backup:UpdateRecoveryPointLifecycle'],
      Resource: '*',
    },
  ],
});

describe('buildActionPreviewDirect — BackupVault_ApplyProtectionPolicy', () => {
  it('vault is not protected yet -> params.currentlyProtected = "no"', async () => {
    backupSendMock.mockResolvedValue({ Policy: undefined });

    const preview = await buildActionPreviewDirect('BackupVault_ApplyProtectionPolicy', 'Default');

    expect(preview.actionType).toBe('BackupVault_ApplyProtectionPolicy');
    expect(preview.reversibilityClass).toBe('reversible');
    expect(preview.params).toEqual({ currentlyProtected: 'no' });
    expect(preview.resource.id).toBe('Default');
  });

  it('vault has no access policy yet (ResourceNotFoundException) -> params.currentlyProtected = "no", does NOT throw', async () => {
    backupSendMock.mockImplementation(async () => {
      const err = new Error('no policy');
      err.name = 'ResourceNotFoundException';
      throw err;
    });

    const preview = await buildActionPreviewDirect('BackupVault_ApplyProtectionPolicy', 'Default');

    expect(preview.params).toEqual({ currentlyProtected: 'no' });
  });

  it('vault is ALREADY sufficiently protected -> params.currentlyProtected = "yes"', async () => {
    backupSendMock.mockResolvedValue({ Policy: PROTECTED_POLICY });

    const preview = await buildActionPreviewDirect('BackupVault_ApplyProtectionPolicy', 'ACME_Vault');

    expect(preview.params).toEqual({ currentlyProtected: 'yes' });
  });

  it('throws badRequest when GetBackupVaultAccessPolicy throws an error OTHER THAN ResourceNotFoundException', async () => {
    backupSendMock.mockRejectedValue(new Error('AccessDenied'));

    await expect(buildActionPreviewDirect('BackupVault_ApplyProtectionPolicy', 'ACME_Vault')).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('buildActionPreviewDirect — BackupRestoreTesting_CreatePlan', () => {
  it('plan does not exist yet -> params.planAlreadyExists = "no"', async () => {
    backupSendMock.mockResolvedValue({ RestoreTestingPlans: [] });

    const preview = await buildActionPreviewDirect('BackupRestoreTesting_CreatePlan', 'account-wide');

    expect(preview.actionType).toBe('BackupRestoreTesting_CreatePlan');
    expect(preview.reversibilityClass).toBe('reversible');
    expect(preview.params).toEqual({ planAlreadyExists: 'no' });
    expect(preview.resource.id).toBe('account-wide');
  });

  it('plan ALREADY exists -> params.planAlreadyExists = "yes"', async () => {
    backupSendMock.mockResolvedValue({
      RestoreTestingPlans: [{ RestoreTestingPlanName: 'abc_prod_restore_testing_plan' }],
    });

    const preview = await buildActionPreviewDirect('BackupRestoreTesting_CreatePlan', 'account-wide');

    expect(preview.params).toEqual({ planAlreadyExists: 'yes' });
  });

  it('throws badRequest when ListRestoreTestingPlans throws', async () => {
    backupSendMock.mockRejectedValue(new Error('AccessDenied'));

    await expect(buildActionPreviewDirect('BackupRestoreTesting_CreatePlan', 'account-wide')).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('buildActionPreviewDirect — Backup_RetryJob', () => {
  const RESOURCE_ARN = 'arn:aws:rds:ap-southeast-1:123456789012:db:acme-rds-production-env';

  it('has a prior backup job -> params.backupVaultName comes from the most recent job', async () => {
    backupSendMock.mockResolvedValue({ BackupJobs: [{ BackupVaultName: 'ACME_Vault' }] });

    const preview = await buildActionPreviewDirect('Backup_RetryJob', RESOURCE_ARN);

    expect(preview.actionType).toBe('Backup_RetryJob');
    expect(preview.reversibilityClass).toBe('reversible');
    expect(preview.params).toEqual({ backupVaultName: 'ACME_Vault' });
    expect(preview.resource.id).toBe(RESOURCE_ARN);
    expect(preview.resource.arn).toBe(RESOURCE_ARN);
  });

  it('throws badRequest when there is no prior backup job', async () => {
    backupSendMock.mockResolvedValue({ BackupJobs: [] });

    await expect(buildActionPreviewDirect('Backup_RetryJob', RESOURCE_ARN)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('throws badRequest when ListBackupJobs throws', async () => {
    backupSendMock.mockRejectedValue(new Error('AccessDenied'));

    await expect(buildActionPreviewDirect('Backup_RetryJob', RESOURCE_ARN)).rejects.toMatchObject({ statusCode: 400 });
  });
});
