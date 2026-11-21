import { describe, it, expect, vi, beforeEach } from 'vitest';

const rdsSendMock = vi.fn();
const ec2SendMock = vi.fn();
const postAlertEmbedsMock = vi.fn();
const waitUntilInstanceStoppedMock = vi.fn();

vi.mock('@aws-sdk/client-rds', () => ({
  RDSClient: vi.fn().mockImplementation(() => ({ send: rdsSendMock })),
  ModifyDBInstanceCommand: vi.fn().mockImplementation((input: unknown) => ({ __cmd: 'ModifyDBInstance', input })),
}));

vi.mock('@aws-sdk/client-ec2', () => ({
  EC2Client: vi.fn().mockImplementation(() => ({ send: ec2SendMock })),
  DescribeInstancesCommand: vi.fn().mockImplementation((input: unknown) => ({ __cmd: 'DescribeInstances', input })),
  StopInstancesCommand: vi.fn().mockImplementation((input: unknown) => ({ __cmd: 'StopInstances', input })),
  StartInstancesCommand: vi.fn().mockImplementation((input: unknown) => ({ __cmd: 'StartInstances', input })),
  ModifyInstanceAttributeCommand: vi.fn().mockImplementation((input: unknown) => ({ __cmd: 'ModifyInstanceAttribute', input })),
  waitUntilInstanceStopped: (...args: unknown[]) => waitUntilInstanceStoppedMock(...args),
}));

vi.mock('../alerting/alertHook.js', () => ({
  postAlertEmbeds: postAlertEmbedsMock,
}));

const { handler } = await import('./downsize-scheduler.js');

beforeEach(() => {
  rdsSendMock.mockReset();
  ec2SendMock.mockReset();
  postAlertEmbedsMock.mockReset();
  waitUntilInstanceStoppedMock.mockReset();
  postAlertEmbedsMock.mockResolvedValue(undefined);
  waitUntilInstanceStoppedMock.mockResolvedValue(undefined);
});

function findField(embed: { fields: { name: string; value: string }[] }, name: string) {
  const field = embed.fields.find((f) => f.name === name);
  if (!field) throw new Error(`no field named "${name}" (fields: ${embed.fields.map((f) => f.name).join(', ')})`);
  return field;
}

describe('downsize-scheduler handler — RDS', () => {
  it('success -> includes a Rollback field with the original DBInstanceClass', async () => {
    rdsSendMock.mockResolvedValue({ DBInstance: { DBInstanceClass: 'db.m7g.xlarge' } });

    const result = await handler({ rds: { instanceIdentifier: 'abc-prod-rds-postgres', targetClass: 'db.m7g.large' } });

    expect(result.rdsOutcome).toBe('success');
    expect(postAlertEmbedsMock).toHaveBeenCalledTimes(1);
    const embed = postAlertEmbedsMock.mock.calls[0][0][0];
    const rollback = findField(embed, 'Rollback');
    expect(rollback.value).toContain('db.m7g.xlarge');
    expect(rollback.value).toContain('abc-prod-rds-postgres');
  });

  it('ModifyDBInstance response has no DBInstance (unexpected shape) -> no Rollback field, does not throw', async () => {
    rdsSendMock.mockResolvedValue({});

    const result = await handler({ rds: { instanceIdentifier: 'abc-prod-rds-postgres', targetClass: 'db.m7g.large' } });

    expect(result.rdsOutcome).toBe('success');
    const embed = postAlertEmbedsMock.mock.calls[0][0][0];
    expect(embed.fields.find((f: { name: string }) => f.name === 'Rollback')).toBeUndefined();
  });

  it('ModifyDBInstance fails -> reports failure, no Rollback field', async () => {
    rdsSendMock.mockRejectedValue(new Error('InvalidDBInstanceState'));

    const result = await handler({ rds: { instanceIdentifier: 'abc-prod-rds-postgres', targetClass: 'db.m7g.large' } });

    expect(result.rdsOutcome).toBe('failure');
    const embed = postAlertEmbedsMock.mock.calls[0][0][0];
    expect(embed.fields.find((f: { name: string }) => f.name === 'Rollback')).toBeUndefined();
  });

  it('availabilityZone only (no targetClass) -> sends AvailabilityZone, not DBInstanceClass, and Rollback names the previous AZ', async () => {
    rdsSendMock.mockResolvedValue({ DBInstance: { DBInstanceClass: 'db.m7g.large', AvailabilityZone: 'ap-southeast-1b' } });

    const result = await handler({ rds: { instanceIdentifier: 'abc-prod-rds-postgres', availabilityZone: 'ap-southeast-1a' } });

    expect(result.rdsOutcome).toBe('success');
    const sentInput = rdsSendMock.mock.calls[0][0].input;
    expect(sentInput).toMatchObject({ DBInstanceIdentifier: 'abc-prod-rds-postgres', AvailabilityZone: 'ap-southeast-1a' });
    expect(sentInput.DBInstanceClass).toBeUndefined();
    const embed = postAlertEmbedsMock.mock.calls[0][0][0];
    const rollback = findField(embed, 'Rollback');
    expect(rollback.value).toContain('ap-southeast-1b');
    expect(rollback.value).not.toContain('class back to');
  });
});

describe('downsize-scheduler handler — EC2', () => {
  it('success (instance was running) -> includes a Rollback field with the original InstanceType and the stop/start caveat', async () => {
    ec2SendMock.mockImplementation((command: { __cmd: string }) => {
      if (command.__cmd === 'DescribeInstances') {
        return Promise.resolve({
          Reservations: [{ Instances: [{ InstanceId: 'i-abc', InstanceType: 'm5.xlarge', State: { Name: 'running' }, Tags: [{ Key: 'Name', Value: 'abc-prod-ec2-webapp' }] }] }],
        });
      }
      return Promise.resolve({});
    });

    const result = await handler({ ec2: { instanceId: 'i-abc', targetType: 'm5.large' } });

    expect(result.ec2Outcome).toBe('success');
    const embed = postAlertEmbedsMock.mock.calls[0][0][0];
    const rollback = findField(embed, 'Rollback');
    expect(rollback.value).toContain('m5.xlarge');
    expect(rollback.value).toContain('abc-prod-ec2-webapp');
    expect(rollback.value).toContain('stop');
    expect(rollback.value).toContain('CPU architecture');
  });

  it('success (instance was not running) -> Rollback field notes ModifyInstanceAttribute only, no stop/start', async () => {
    ec2SendMock.mockImplementation((command: { __cmd: string }) => {
      if (command.__cmd === 'DescribeInstances') {
        return Promise.resolve({
          Reservations: [{ Instances: [{ InstanceId: 'i-abc', InstanceType: 'm5.xlarge', State: { Name: 'stopped' }, Tags: [] }] }],
        });
      }
      return Promise.resolve({});
    });

    await handler({ ec2: { instanceId: 'i-abc', targetType: 'm5.large' } });

    const embed = postAlertEmbedsMock.mock.calls[0][0][0];
    const rollback = findField(embed, 'Rollback');
    expect(rollback.value).toContain('ModifyInstanceAttribute');
    expect(rollback.value).not.toContain('stop, ModifyInstanceAttribute');
  });

  it('ModifyInstanceAttribute fails -> reports failure, no Rollback field', async () => {
    ec2SendMock.mockImplementation((command: { __cmd: string }) => {
      if (command.__cmd === 'DescribeInstances') {
        return Promise.resolve({
          Reservations: [{ Instances: [{ InstanceId: 'i-abc', InstanceType: 'm5.xlarge', State: { Name: 'stopped' }, Tags: [] }] }],
        });
      }
      if (command.__cmd === 'ModifyInstanceAttribute') return Promise.reject(new Error('IncorrectInstanceState'));
      return Promise.resolve({});
    });

    const result = await handler({ ec2: { instanceId: 'i-abc', targetType: 'm5.large' } });

    expect(result.ec2Outcome).toBe('failure');
    const embed = postAlertEmbedsMock.mock.calls[0][0][0];
    expect(embed.fields.find((f: { name: string }) => f.name === 'Rollback')).toBeUndefined();
  });
});

describe('downsize-scheduler handler — combined', () => {
  it('both rds and ec2 provided -> sends both embeds in one postAlertEmbeds call, skipped is never used', async () => {
    rdsSendMock.mockResolvedValue({ DBInstance: { DBInstanceClass: 'db.m7g.xlarge' } });
    ec2SendMock.mockImplementation((command: { __cmd: string }) => {
      if (command.__cmd === 'DescribeInstances') {
        return Promise.resolve({ Reservations: [{ Instances: [{ InstanceId: 'i-abc', InstanceType: 'm5.xlarge', State: { Name: 'stopped' }, Tags: [] }] }] });
      }
      return Promise.resolve({});
    });

    const result = await handler({
      rds: { instanceIdentifier: 'abc-prod-rds-postgres', targetClass: 'db.m7g.large' },
      ec2: { instanceId: 'i-abc', targetType: 'm5.large' },
    });

    expect(result).toEqual({ ok: true, rdsOutcome: 'success', ec2Outcome: 'success' });
    expect(postAlertEmbedsMock).toHaveBeenCalledTimes(1);
    expect(postAlertEmbedsMock.mock.calls[0][0]).toHaveLength(2);
  });

  it('neither rds nor ec2 provided -> does not call postAlertEmbeds, returns skipped/skipped', async () => {
    const result = await handler({});
    expect(result).toEqual({ ok: true, rdsOutcome: 'skipped', ec2Outcome: 'skipped' });
    expect(postAlertEmbedsMock).not.toHaveBeenCalled();
  });
});
