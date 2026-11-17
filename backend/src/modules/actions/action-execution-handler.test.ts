import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../config.ts', () => ({
  config: {
    allowedOrigins: [],
    entraTenantId: 'test-tenant',
    entraClientId: 'test-client',
    allowedGroupIds: [],
    operatorGroupIds: [],
    awsRegion: 'ap-southeast-1',
    awsAccountId: '123456789012',
    assessmentBucketName: 'test-bucket',
    ec2StateManagerServiceTokenParamName: 'test-param',
    ec2StateManagerFunctionUrl: 'https://test.lambda-url.ap-southeast-1.on.aws/',
    actionExecutionFunctionName: 'action-execution-fn',
    scheduledActionsMutateFunctionName: 'scheduled-actions-mutate-fn',
  },
}));

vi.mock('../../shared-kernel/logger.js', () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
  setCorrelationId: vi.fn(),
}));

const executeEc2RebootMock = vi.fn();
const executeRdsStartMock = vi.fn();
const executeRdsStopMock = vi.fn();
const executeRdsRebootMock = vi.fn();

vi.mock('./ec2-reboot-action-service.js', () => ({
  executeEc2Reboot: (id: string) => executeEc2RebootMock(id),
}));
vi.mock('./rds-lifecycle-action-service.js', () => ({
  executeRdsStart: (id: string) => executeRdsStartMock(id),
  executeRdsStop: (id: string) => executeRdsStopMock(id),
  executeRdsReboot: (id: string) => executeRdsRebootMock(id),
}));

vi.mock('./action-audit-service.js', () => ({
  writeAuditRecord: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./ebs-action-service.js', () => ({
  executeSnapshotAndDeleteEbsVolume: vi.fn(),
}));

vi.mock('./s3-lifecycle-action-service.js', () => ({
  executeApplyS3LifecyclePolicy: vi.fn(),
}));

vi.mock('./ec2-state-manager-client.js', () => ({
  callEc2StateManager: vi.fn(),
}));

vi.mock('./ecs-scale-action-service.js', () => ({
  executeEcsScaleOut: vi.fn(),
}));

vi.mock('./rds-storage-action-service.js', () => ({
  executeRdsIncreaseStorage: vi.fn(),
}));

vi.mock('./ebs-modify-volume-type-action-service.js', () => ({
  executeEbsModifyVolumeType: vi.fn(),
}));

vi.mock('./cloudwatch-log-retention-action-service.js', () => ({
  executeCloudWatchLogRetention: vi.fn(),
}));

vi.mock('./elastic-ip-release-action-service.js', () => ({
  executeElasticIpRelease: vi.fn(),
}));

vi.mock('./ec2-rightsize-action-service.js', () => ({
  executeEc2Rightsize: vi.fn(),
}));

vi.mock('./backup-vault-protection-action-service.js', () => ({
  executeBackupVaultApplyProtectionPolicy: vi.fn(),
}));

vi.mock('./backup-restore-testing-action-service.js', () => ({
  executeBackupRestoreTestingCreatePlan: vi.fn(),
}));

vi.mock('./backup-retry-job-action-service.js', () => ({
  executeBackupRetryJob: vi.fn(),
}));

vi.mock('./rds-resource-governance-action-service.js', () => ({
  executeRdsApplyResourceGovernance: vi.fn(),
}));

const { handler } = await import('./action-execution-handler.js');

function buildRequest(actionType: string, resourceId: string) {
  return { actionType, resourceId, region: 'ap-southeast-1', params: {}, executedBy: 'test@example.com' };
}

describe('action-execution-handler dispatch — lifecycle actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it('EC2_Reboot uses executeEc2Reboot', async () => {
    executeEc2RebootMock.mockResolvedValue({ outcome: 'success', newState: 'rebooting' });
    const result = await handler(buildRequest('EC2_Reboot', 'i-abc') as any);
    expect(executeEc2RebootMock).toHaveBeenCalledWith('i-abc');
    expect(result.outcome).toBe('success');
  });

  it('RDS_Start uses executeRdsStart', async () => {
    executeRdsStartMock.mockResolvedValue({ outcome: 'success', newState: 'starting' });
    const result = await handler(buildRequest('RDS_Start', 'db-1') as any);
    expect(executeRdsStartMock).toHaveBeenCalledWith('db-1');
    expect(result.outcome).toBe('success');
  });

  it('RDS_Stop uses executeRdsStop', async () => {
    executeRdsStopMock.mockResolvedValue({ outcome: 'success', newState: 'stopping' });
    const result = await handler(buildRequest('RDS_Stop', 'db-1') as any);
    expect(executeRdsStopMock).toHaveBeenCalledWith('db-1');
    expect(result.outcome).toBe('success');
  });

  it('RDS_Reboot uses executeRdsReboot', async () => {
    executeRdsRebootMock.mockResolvedValue({ outcome: 'success', newState: 'rebooting' });
    const result = await handler(buildRequest('RDS_Reboot', 'db-1') as any);
    expect(executeRdsRebootMock).toHaveBeenCalledWith('db-1');
    expect(result.outcome).toBe('success');
  });
});
