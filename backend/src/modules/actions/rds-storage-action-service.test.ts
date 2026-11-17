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

const rdsSendMock = vi.fn();

vi.mock('@aws-sdk/client-rds', () => ({
  RDSClient: vi.fn().mockImplementation(() => ({ send: rdsSendMock })),
  DescribeDBInstancesCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'DescribeDBInstances', input })),
  ModifyDBInstanceCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'ModifyDBInstance', input })),
}));

const { executeRdsIncreaseStorage } = await import('./rds-storage-action-service.js');

beforeEach(() => {
  rdsSendMock.mockReset();
});

describe('executeRdsIncreaseStorage', () => {
  it('succeeds: re-reads the current AllocatedStorage, ModifyDBInstance with target +20%, ApplyImmediately=true', async () => {
    let capturedModifyInput: unknown;
    rdsSendMock.mockImplementation(async (command: { __type?: string; input?: unknown }) => {
      if (command.__type === 'DescribeDBInstances') {
        return { DBInstances: [{ AllocatedStorage: 100, DBInstanceStatus: 'available' }] };
      }
      if (command.__type === 'ModifyDBInstance') {
        capturedModifyInput = command.input;
        return {};
      }
      throw new Error('unexpected');
    });

    const result = await executeRdsIncreaseStorage('abc-prod-rds');

    expect(result).toEqual({ outcome: 'success', newAllocatedStorageGb: 120 });
    expect(capturedModifyInput).toMatchObject({
      DBInstanceIdentifier: 'abc-prod-rds',
      AllocatedStorage: 120,
      ApplyImmediately: true,
    });
  });

  it('rejected: instance does not exist at execution time — does NOT call ModifyDBInstance', async () => {
    rdsSendMock.mockResolvedValue({ DBInstances: [] });

    const result = await executeRdsIncreaseStorage('unknown-db');

    expect(result.outcome).toBe('rejected');
    expect(rdsSendMock).toHaveBeenCalledTimes(1);
  });

  it.each(['modifying', 'storage-optimization', 'upgrading', 'maintenance'])(
    'rejected: instance is in blocking state "%s" — does NOT call ModifyDBInstance',
    async (status) => {
      rdsSendMock.mockResolvedValue({ DBInstances: [{ AllocatedStorage: 100, DBInstanceStatus: status }] });

      const result = await executeRdsIncreaseStorage('abc-prod-rds');

      expect(result.outcome).toBe('rejected');
      expect(rdsSendMock).toHaveBeenCalledTimes(1);
    },
  );

  it('failure: ModifyDBInstance throws → outcome failure, does NOT throw outward', async () => {
    rdsSendMock.mockImplementation(async (command: { __type?: string }) => {
      if (command.__type === 'DescribeDBInstances') {
        return { DBInstances: [{ AllocatedStorage: 50, DBInstanceStatus: 'available' }] };
      }
      if (command.__type === 'ModifyDBInstance') throw new Error('InvalidParameterCombination');
      throw new Error('unexpected');
    });

    const result = await executeRdsIncreaseStorage('abc-prod-rds');

    expect(result.outcome).toBe('failure');
    expect(result.reason).toContain('InvalidParameterCombination');
  });

  it('failure: DescribeDBInstances throws → outcome failure', async () => {
    rdsSendMock.mockRejectedValue(new Error('network error'));

    const result = await executeRdsIncreaseStorage('abc-prod-rds');

    expect(result.outcome).toBe('failure');
  });
});
