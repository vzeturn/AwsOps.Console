import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.AWS_REGION = 'ap-southeast-1';

const rdsSendMock = vi.fn();

vi.mock('@aws-sdk/client-rds', () => ({
  RDSClient: vi.fn().mockImplementation(() => ({ send: rdsSendMock })),
  DescribeDBInstancesCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'DescribeDBInstances', input })),
  ListTagsForResourceCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'ListTagsForResource', input })),
  StopDBInstanceCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'StopDBInstance', input })),
  StartDBInstanceCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'StartDBInstance', input })),
}));

vi.mock('../alerting/discordWebhook.js', () => ({ postDiscordEmbeds: vi.fn() }));

const { handler } = await import('./rds-nightly-scheduler.js');

const DB_ARN = 'arn:aws:rds:ap-southeast-1:123456789012:db:abc-stg-rds-postgres';

beforeEach(() => {
  rdsSendMock.mockReset();
});

function mockManagedInstance(status: string) {
  rdsSendMock.mockImplementation(async (command: { __type?: string; input?: any }) => {
    if (command.__type === 'DescribeDBInstances' && !command.input?.DBInstanceIdentifier) {
      return { DBInstances: [{ DBInstanceArn: DB_ARN, DBInstanceIdentifier: 'abc-stg-rds-postgres' }] };
    }
    if (command.__type === 'ListTagsForResource') {
      return { TagList: [{ Key: 'RdsNightlyScheduler:Managed', Value: 'true' }] };
    }
    if (command.__type === 'DescribeDBInstances' && command.input?.DBInstanceIdentifier) {
      return { DBInstances: [{ DBInstanceStatus: status }] };
    }
    if (command.__type === 'StopDBInstance' || command.__type === 'StartDBInstance') {
      return {};
    }
    throw new Error(`unexpected RDS command in test mock: ${command.__type}`);
  });
}

describe('rds-nightly-scheduler', () => {
  it('rejects an event with a missing/invalid action', async () => {
    await expect(handler({} as any)).rejects.toThrow(/invalid action/);
  });

  it('stops a managed, available instance on action=stop', async () => {
    mockManagedInstance('available');

    const result = await handler({ action: 'stop' });

    expect(result.results['abc-stg-rds-postgres']).toBe('stop requested (was available)');
    expect(rdsSendMock).toHaveBeenCalledWith(expect.objectContaining({ __type: 'StopDBInstance', input: { DBInstanceIdentifier: 'abc-stg-rds-postgres' } }));
  });

  it('skips stopping an instance that is not available (e.g. already stopped)', async () => {
    mockManagedInstance('stopped');

    const result = await handler({ action: 'stop' });

    expect(result.results['abc-stg-rds-postgres']).toBe('skipped (status=stopped)');
    expect(rdsSendMock).not.toHaveBeenCalledWith(expect.objectContaining({ __type: 'StopDBInstance' }));
  });

  it('starts a managed, stopped instance on action=start', async () => {
    mockManagedInstance('stopped');

    const result = await handler({ action: 'start' });

    expect(result.results['abc-stg-rds-postgres']).toBe('start requested (was stopped)');
    expect(rdsSendMock).toHaveBeenCalledWith(expect.objectContaining({ __type: 'StartDBInstance', input: { DBInstanceIdentifier: 'abc-stg-rds-postgres' } }));
  });

  it('ignores an RDS instance that is not tagged rds-nightly-scheduler:managed=true', async () => {
    rdsSendMock.mockImplementation(async (command: { __type?: string }) => {
      if (command.__type === 'DescribeDBInstances') {
        return { DBInstances: [{ DBInstanceArn: DB_ARN, DBInstanceIdentifier: 'abc-prod-rds-postgres' }] };
      }
      if (command.__type === 'ListTagsForResource') {
        return { TagList: [] };
      }
      throw new Error(`unexpected RDS command in test mock: ${command.__type}`);
    });

    const result = await handler({ action: 'stop' });

    expect(result.results).toEqual({});
  });
});
