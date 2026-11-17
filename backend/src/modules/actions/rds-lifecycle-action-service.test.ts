import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../config.js', () => ({
  config: { awsRegion: 'ap-southeast-1' },
}));

const rdsSendMock = vi.fn();
vi.mock('@aws-sdk/client-rds', () => ({
  RDSClient: vi.fn().mockImplementation(() => ({ send: rdsSendMock })),
  DescribeDBInstancesCommand: vi.fn().mockImplementation((input) => ({ __type: 'DescribeDBInstances', input })),
  StartDBInstanceCommand: vi.fn().mockImplementation((input) => ({ __type: 'StartDBInstance', input })),
  StopDBInstanceCommand: vi.fn().mockImplementation((input) => ({ __type: 'StopDBInstance', input })),
  RebootDBInstanceCommand: vi.fn().mockImplementation((input) => ({ __type: 'RebootDBInstance', input })),
}));

const { executeRdsStart, executeRdsStop, executeRdsReboot } = await import('./rds-lifecycle-action-service.js');

beforeEach(() => {
  rdsSendMock.mockReset();
});

describe('executeRdsStart', () => {
  it('succeeds when status is "stopped"', async () => {
    rdsSendMock
      .mockResolvedValueOnce({ DBInstances: [{ DBInstanceStatus: 'stopped' }] })
      .mockResolvedValueOnce({});

    const result = await executeRdsStart('db-1');

    expect(result).toEqual({ outcome: 'success', newState: 'starting' });
  });

  it('rejected when status is not "stopped"', async () => {
    rdsSendMock.mockResolvedValueOnce({ DBInstances: [{ DBInstanceStatus: 'available' }] });

    const result = await executeRdsStart('db-1');

    expect(result.outcome).toBe('rejected');
  });

  it('rejected when the instance does not exist', async () => {
    rdsSendMock.mockResolvedValueOnce({ DBInstances: [] });

    const result = await executeRdsStart('db-missing');

    expect(result.outcome).toBe('rejected');
  });
});

describe('executeRdsStop', () => {
  it('succeeds when status is "available"', async () => {
    rdsSendMock
      .mockResolvedValueOnce({ DBInstances: [{ DBInstanceStatus: 'available' }] })
      .mockResolvedValueOnce({});

    const result = await executeRdsStop('db-1');

    expect(result).toEqual({ outcome: 'success', newState: 'stopping' });
  });

  it('rejected when status is not "available"', async () => {
    rdsSendMock.mockResolvedValueOnce({ DBInstances: [{ DBInstanceStatus: 'stopped' }] });

    const result = await executeRdsStop('db-1');

    expect(result.outcome).toBe('rejected');
  });

  it('failure when StopDBInstance errors (e.g. Multi-AZ rejected by the RDS API)', async () => {
    rdsSendMock
      .mockResolvedValueOnce({ DBInstances: [{ DBInstanceStatus: 'available' }] })
      .mockRejectedValueOnce(new Error('InvalidDBInstanceState: cannot stop Multi-AZ'));

    const result = await executeRdsStop('db-1');

    expect(result.outcome).toBe('failure');
  });
});

describe('executeRdsReboot', () => {
  it('succeeds when status is "available"', async () => {
    rdsSendMock
      .mockResolvedValueOnce({ DBInstances: [{ DBInstanceStatus: 'available' }] })
      .mockResolvedValueOnce({});

    const result = await executeRdsReboot('db-1');

    expect(result).toEqual({ outcome: 'success', newState: 'rebooting' });
  });

  it('rejected when status is not "available"', async () => {
    rdsSendMock.mockResolvedValueOnce({ DBInstances: [{ DBInstanceStatus: 'stopped' }] });

    const result = await executeRdsReboot('db-1');

    expect(result.outcome).toBe('rejected');
  });
});
