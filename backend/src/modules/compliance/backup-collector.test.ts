import { describe, it, expect, vi, beforeEach } from 'vitest';

// Task 6.14: unit tests for backup-collector.ts
// The collector reads the region directly from process.env.AWS_REGION (the Lambda runtime always
// sets this variable itself) — set before importing the module; no longer mocks config.ts (the
// collector doesn't import config.ts).
process.env.AWS_REGION = 'ap-southeast-1';

const backupSendMock = vi.fn();
const dlmSendMock = vi.fn();
const ec2SendMock = vi.fn();

// Each command is tagged with `commandName` so backupSendMock/dlmSendMock can distinguish command
// types (BackupClient/DLMClient receive several different command types within this one
// collector, unlike ec2-collector.test.ts/rds-collector.test.ts which only have 1 command type
// per client).
vi.mock('@aws-sdk/client-backup', () => ({
  BackupClient: vi.fn().mockImplementation(() => ({ send: backupSendMock })),
  ListBackupJobsCommand: vi.fn().mockImplementation((input: unknown) => ({ commandName: 'ListBackupJobsCommand', input })),
  ListBackupPlansCommand: vi.fn().mockImplementation((input: unknown) => ({ commandName: 'ListBackupPlansCommand', input })),
  ListBackupSelectionsCommand: vi
    .fn()
    .mockImplementation((input: unknown) => ({ commandName: 'ListBackupSelectionsCommand', input })),
  GetBackupSelectionCommand: vi
    .fn()
    .mockImplementation((input: unknown) => ({ commandName: 'GetBackupSelectionCommand', input })),
  ListBackupVaultsCommand: vi
    .fn()
    .mockImplementation((input: unknown) => ({ commandName: 'ListBackupVaultsCommand', input })),
  GetBackupVaultAccessPolicyCommand: vi
    .fn()
    .mockImplementation((input: unknown) => ({ commandName: 'GetBackupVaultAccessPolicyCommand', input })),
  ListRestoreTestingPlansCommand: vi
    .fn()
    .mockImplementation((input: unknown) => ({ commandName: 'ListRestoreTestingPlansCommand', input })),
}));

vi.mock('@aws-sdk/client-dlm', () => ({
  DLMClient: vi.fn().mockImplementation(() => ({ send: dlmSendMock })),
  GetLifecyclePoliciesCommand: vi
    .fn()
    .mockImplementation((input: unknown) => ({ commandName: 'GetLifecyclePoliciesCommand', input })),
  GetLifecyclePolicyCommand: vi
    .fn()
    .mockImplementation((input: unknown) => ({ commandName: 'GetLifecyclePolicyCommand', input })),
}));

vi.mock('@aws-sdk/client-ec2', () => ({
  EC2Client: vi.fn().mockImplementation(() => ({ send: ec2SendMock })),
  DescribeVolumesCommand: vi
    .fn()
    .mockImplementation((input: unknown) => ({ commandName: 'DescribeVolumesCommand', input })),
}));

// Import after the mocks are declared (vi.mock is hoisted to the top by vitest).
const { collectBackupData } = await import('./backup-collector.js');

/** Default: no backup plan / job / DLM policy / vault / restore testing plan at all — each test overrides what it needs. */
function mockEmptyBackupResponses() {
  backupSendMock.mockImplementation(async (command: { commandName: string }) => {
    switch (command.commandName) {
      case 'ListBackupPlansCommand':
        return { BackupPlansList: [] };
      case 'ListBackupJobsCommand':
        return { BackupJobs: [] };
      case 'ListBackupSelectionsCommand':
        return { BackupSelectionsList: [] };
      case 'GetBackupSelectionCommand':
        return { BackupSelection: { Resources: [] } };
      case 'ListBackupVaultsCommand':
        return { BackupVaultList: [] };
      case 'GetBackupVaultAccessPolicyCommand':
        return { Policy: undefined };
      case 'ListRestoreTestingPlansCommand':
        return { RestoreTestingPlans: [] };
      default:
        return {};
    }
  });
  dlmSendMock.mockImplementation(async (command: { commandName: string }) => {
    switch (command.commandName) {
      case 'GetLifecyclePoliciesCommand':
        return { Policies: [] };
      default:
        return {};
    }
  });
  ec2SendMock.mockResolvedValue({ Volumes: [] });
}

beforeEach(() => {
  backupSendMock.mockReset();
  dlmSendMock.mockReset();
  ec2SendMock.mockReset();
  mockEmptyBackupResponses();
});

describe('collectBackupData', () => {
  it('a backup job in FAILED state appears correctly in recentBackupJobs', async () => {
    backupSendMock.mockImplementation(async (command: { commandName: string }) => {
      switch (command.commandName) {
        case 'ListBackupPlansCommand':
          return { BackupPlansList: [] };
        case 'ListBackupJobsCommand':
          return {
            BackupJobs: [
              {
                BackupJobId: 'job-failed-1',
                ResourceArn: 'arn:aws:ec2:ap-southeast-1:123456789012:volume/vol-abc123',
                ResourceName: 'vol-abc123',
                ResourceType: 'EBS',
                State: 'FAILED',
                CreationDate: new Date('2024-01-15T10:00:00.000Z'),
              },
            ],
          };
        case 'ListBackupSelectionsCommand':
          return { BackupSelectionsList: [] };
        default:
          return {};
      }
    });

    const result = await collectBackupData();

    expect(result.recentBackupJobs).toHaveLength(1);
    expect(result.recentBackupJobs[0]).toMatchObject({
      jobId: 'job-failed-1',
      resourceArn: 'arn:aws:ec2:ap-southeast-1:123456789012:volume/vol-abc123',
      resourceType: 'EBS',
      state: 'FAILED',
      creationDate: '2024-01-15T10:00:00.000Z',
    });
  });

  it('no backup plans at all (ListBackupPlansCommand returns empty) -> backupPlans=[] and resourceArnsWithBackupPlan=[]', async () => {
    // mockEmptyBackupResponses() (beforeEach) already returns BackupPlansList=[] — no need to override further.
    const result = await collectBackupData();

    expect(result.backupPlans).toEqual([]);
    expect(result.resourceArnsWithBackupPlan).toEqual([]);
    // With no plans at all, ListBackupSelections/GetBackupSelection should not be called.
    expect(backupSendMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ commandName: 'ListBackupSelectionsCommand' }),
    );
  });

  it('GetLifecyclePolicies (DLM) throwing does not break backupPlans/recentBackupJobs', async () => {
    backupSendMock.mockImplementation(async (command: { commandName: string }) => {
      switch (command.commandName) {
        case 'ListBackupPlansCommand':
          return {
            BackupPlansList: [
              {
                BackupPlanId: 'plan-1',
                BackupPlanArn: 'arn:aws:backup:ap-southeast-1:123456789012:backup-plan:plan-1',
                BackupPlanName: 'daily-plan',
                CreationDate: new Date('2024-01-01T00:00:00.000Z'),
                LastExecutionDate: new Date('2024-01-15T00:00:00.000Z'),
              },
            ],
          };
        case 'ListBackupJobsCommand':
          return { BackupJobs: [] };
        case 'ListBackupSelectionsCommand':
          return { BackupSelectionsList: [] };
        default:
          return {};
      }
    });
    dlmSendMock.mockImplementation(async (command: { commandName: string }) => {
      if (command.commandName === 'GetLifecyclePoliciesCommand') {
        throw new Error('AccessDenied');
      }
      return {};
    });

    const result = await collectBackupData();

    expect(result.dlmPolicies).toEqual([]);
    expect(result.resourceArnsWithDlmPolicy).toEqual([]);
    // The other source (backup plans) is still collected correctly, unaffected by the DLM error.
    expect(result.backupPlans).toHaveLength(1);
    expect(result.backupPlans[0]).toMatchObject({
      backupPlanId: 'plan-1',
      backupPlanName: 'daily-plan',
    });
  });

  describe('backupVaults — hasDeletionProtection', () => {
    it('vault has an access policy with a Deny statement covering both actions -> hasDeletionProtection=true', async () => {
      backupSendMock.mockImplementation(async (command: { commandName: string; input?: { BackupVaultName?: string } }) => {
        switch (command.commandName) {
          case 'ListBackupVaultsCommand':
            return {
              BackupVaultList: [
                {
                  BackupVaultName: 'ACME_Vault',
                  BackupVaultArn: 'arn:aws:backup:ap-southeast-1:123456789012:backup-vault:ACME_Vault',
                  NumberOfRecoveryPoints: 122,
                  Locked: false,
                },
              ],
            };
          case 'GetBackupVaultAccessPolicyCommand':
            return {
              Policy: JSON.stringify({
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
              }),
            };
          case 'ListBackupPlansCommand':
            return { BackupPlansList: [] };
          case 'ListBackupJobsCommand':
            return { BackupJobs: [] };
          default:
            return {};
        }
      });

      const result = await collectBackupData();

      expect(result.backupVaults).toHaveLength(1);
      expect(result.backupVaults[0]).toMatchObject({
        vaultName: 'ACME_Vault',
        numberOfRecoveryPoints: 122,
        hasDeletionProtection: true,
      });
    });

    it('vault has NO access policy (GetBackupVaultAccessPolicy throws ResourceNotFoundException) -> hasDeletionProtection=false', async () => {
      backupSendMock.mockImplementation(async (command: { commandName: string }) => {
        switch (command.commandName) {
          case 'ListBackupVaultsCommand':
            return {
              BackupVaultList: [
                {
                  BackupVaultName: 'Default',
                  BackupVaultArn: 'arn:aws:backup:ap-southeast-1:123456789012:backup-vault:Default',
                  NumberOfRecoveryPoints: 0,
                  Locked: false,
                },
              ],
            };
          case 'GetBackupVaultAccessPolicyCommand': {
            const error = new Error('no policy');
            error.name = 'ResourceNotFoundException';
            throw error;
          }
          case 'ListBackupPlansCommand':
            return { BackupPlansList: [] };
          case 'ListBackupJobsCommand':
            return { BackupJobs: [] };
          default:
            return {};
        }
      });

      const result = await collectBackupData();

      expect(result.backupVaults).toHaveLength(1);
      expect(result.backupVaults[0]).toMatchObject({
        vaultName: 'Default',
        hasDeletionProtection: false,
      });
    });

    it('vault has an access policy but is missing one of the 2 required actions -> hasDeletionProtection=false', async () => {
      backupSendMock.mockImplementation(async (command: { commandName: string }) => {
        switch (command.commandName) {
          case 'ListBackupVaultsCommand':
            return {
              BackupVaultList: [
                {
                  BackupVaultName: 'PartialVault',
                  BackupVaultArn: 'arn:aws:backup:ap-southeast-1:123456789012:backup-vault:PartialVault',
                  NumberOfRecoveryPoints: 5,
                  Locked: false,
                },
              ],
            };
          case 'GetBackupVaultAccessPolicyCommand':
            return {
              Policy: JSON.stringify({
                Version: '2012-10-17',
                Statement: [
                  {
                    Effect: 'Deny',
                    Principal: '*',
                    // Only DeleteRecoveryPoint, MISSING UpdateRecoveryPointLifecycle -> not sufficient.
                    Action: ['backup:DeleteRecoveryPoint'],
                    Resource: '*',
                  },
                ],
              }),
            };
          case 'ListBackupPlansCommand':
            return { BackupPlansList: [] };
          case 'ListBackupJobsCommand':
            return { BackupJobs: [] };
          default:
            return {};
        }
      });

      const result = await collectBackupData();

      expect(result.backupVaults[0]).toMatchObject({ hasDeletionProtection: false });
    });
  });

  it('ListBackupJobs returns multiple pages (NextToken) -> loadRecentBackupJobs merges jobs from ALL pages, not just the first 100', async () => {
    backupSendMock.mockImplementation(async (command: { commandName: string; input?: { NextToken?: string } }) => {
      switch (command.commandName) {
        case 'ListBackupJobsCommand':
          if (!command.input?.NextToken) {
            return Promise.resolve({
              BackupJobs: [
                {
                  BackupJobId: 'job-page1',
                  State: 'COMPLETED',
                  ResourceArn: 'arn:aws:ec2:x',
                  ResourceType: 'EC2',
                  CreationDate: new Date('2024-01-15T10:00:00.000Z'),
                },
              ],
              NextToken: 'token-page-2',
            });
          }
          return Promise.resolve({
            BackupJobs: [
              {
                BackupJobId: 'job-page2',
                State: 'FAILED',
                ResourceArn: 'arn:aws:ec2:y',
                ResourceType: 'EC2',
                CreationDate: new Date('2024-01-16T10:00:00.000Z'),
              },
            ],
          });
        case 'ListBackupPlansCommand':
          return { BackupPlansList: [] };
        case 'ListBackupSelectionsCommand':
          return { BackupSelectionsList: [] };
        default:
          return {};
      }
    });

    const data = await collectBackupData();

    const jobIds = data.recentBackupJobs.map((j) => j.jobId);
    expect(jobIds).toContain('job-page1');
    expect(jobIds).toContain('job-page2');
  });

  describe('restoreTestingPlans', () => {
    it('has a restore testing plan -> returns the correct planName/scheduleExpression/lastExecutionTime', async () => {
      backupSendMock.mockImplementation(async (command: { commandName: string }) => {
        switch (command.commandName) {
          case 'ListRestoreTestingPlansCommand':
            return {
              RestoreTestingPlans: [
                {
                  RestoreTestingPlanName: 'abc_prod_restore_testing_plan',
                  RestoreTestingPlanArn: 'arn:aws:backup:ap-southeast-1:123456789012:restore-testing-plan:abc_prod_restore_testing_plan-abc',
                  ScheduleExpression: 'cron(0 21 ? * SUN *)',
                  LastExecutionTime: new Date('2026-08-09T21:00:00.000Z'),
                  CreationTime: new Date('2026-08-01T00:00:00.000Z'),
                },
              ],
            };
          case 'ListBackupPlansCommand':
            return { BackupPlansList: [] };
          case 'ListBackupJobsCommand':
            return { BackupJobs: [] };
          case 'ListBackupVaultsCommand':
            return { BackupVaultList: [] };
          default:
            return {};
        }
      });

      const result = await collectBackupData();

      expect(result.restoreTestingPlans).toHaveLength(1);
      expect(result.restoreTestingPlans[0]).toMatchObject({
        planName: 'abc_prod_restore_testing_plan',
        scheduleExpression: 'cron(0 21 ? * SUN *)',
        lastExecutionTime: '2026-08-09T21:00:00.000Z',
      });
    });

    it('no restore testing plan at all -> returns empty', async () => {
      // mockEmptyBackupResponses() (beforeEach) already returns RestoreTestingPlans=[] — no need to override further.
      const result = await collectBackupData();

      expect(result.restoreTestingPlans).toEqual([]);
    });

    it('ListRestoreTestingPlans throws -> returns empty, does not break backupPlans/dlmPolicies', async () => {
      backupSendMock.mockImplementation(async (command: { commandName: string }) => {
        switch (command.commandName) {
          case 'ListRestoreTestingPlansCommand':
            throw new Error('AccessDenied');
          case 'ListBackupPlansCommand':
            return {
              BackupPlansList: [
                {
                  BackupPlanId: 'plan-1',
                  BackupPlanArn: 'arn:aws:backup:ap-southeast-1:123456789012:backup-plan:plan-1',
                  BackupPlanName: 'daily-plan',
                },
              ],
            };
          case 'ListBackupJobsCommand':
            return { BackupJobs: [] };
          case 'ListBackupSelectionsCommand':
            return { BackupSelectionsList: [] };
          case 'ListBackupVaultsCommand':
            return { BackupVaultList: [] };
          default:
            return {};
        }
      });

      const result = await collectBackupData();

      expect(result.restoreTestingPlans).toEqual([]);
      expect(result.backupPlans).toHaveLength(1);
    });
  });
});
