import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.AWS_REGION = 'ap-southeast-1';

const backupSendMock = vi.fn();
const dlmSendMock = vi.fn();
const configSendMock = vi.fn();

vi.mock('@aws-sdk/client-backup', () => ({
  BackupClient: vi.fn().mockImplementation(() => ({ send: backupSendMock })),
  ListBackupJobsCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
}));

vi.mock('@aws-sdk/client-dlm', () => ({
  DLMClient: vi.fn().mockImplementation(() => ({ send: dlmSendMock })),
  GetLifecyclePoliciesCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
}));

vi.mock('@aws-sdk/client-config-service', () => ({
  ConfigServiceClient: vi.fn().mockImplementation(() => ({ send: configSendMock })),
  DescribeComplianceByConfigRuleCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
}));

vi.mock('../../config.js', () => ({
  config: { awsRegion: 'ap-southeast-1' },
}));

const { getComplianceData } = await import('./compliance-service.js');

beforeEach(() => {
  backupSendMock.mockReset();
  dlmSendMock.mockReset();
  configSendMock.mockReset();
  backupSendMock.mockResolvedValue({ BackupJobs: [] });
  dlmSendMock.mockResolvedValue({ Policies: [] });
  configSendMock.mockResolvedValue({ ComplianceByConfigRules: [] });
});

describe('loadBackupJobs (via getComplianceData)', () => {
  it('merges backup job results across multiple pages when ListBackupJobs returns a NextToken', async () => {
    backupSendMock
      .mockResolvedValueOnce({
        BackupJobs: [{ BackupJobId: 'job-page1', State: 'COMPLETED', CreationDate: new Date('2026-08-01T00:00:00Z') }],
        NextToken: 'token-page-2',
      })
      .mockResolvedValueOnce({
        BackupJobs: [{ BackupJobId: 'job-page2', State: 'FAILED', CreationDate: new Date('2026-08-02T00:00:00Z') }],
      });

    const result = await getComplianceData();

    expect(result.recentBackupJobs.map((j) => j.jobId)).toEqual(['job-page1', 'job-page2']);
    expect(backupSendMock).toHaveBeenCalledTimes(2);
  });

  it('asOf matches generatedAt', async () => {
    const result = await getComplianceData();
    expect(result.asOf).toBe(result.generatedAt);
  });
});

describe('loadConfigCompliance (via getComplianceData)', () => {
  it('DescribeComplianceByConfigRule succeeds (even with 0 rules) -> configStatus = evaluated', async () => {
    configSendMock.mockResolvedValue({ ComplianceByConfigRules: [] });
    const result = await getComplianceData();
    expect(result.configStatus).toBe('evaluated');
    expect(result.configRules).toEqual([]);
  });

  it('DescribeComplianceByConfigRule fails (Config not enabled/API error) -> configStatus = unavailable, NOT treated as compliant', async () => {
    configSendMock.mockRejectedValue(new Error('ConfigServiceClient not enabled'));
    const result = await getComplianceData();
    expect(result.configStatus).toBe('unavailable');
    expect(result.configRules).toEqual([]);
  });
});
