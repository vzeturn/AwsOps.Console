import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.AWS_REGION = 'ap-southeast-1';

const ec2SendMock = vi.fn();
const ssmSendMock = vi.fn();

vi.mock('@aws-sdk/client-ec2', () => ({
  EC2Client: vi.fn().mockImplementation(() => ({ send: ec2SendMock })),
  DescribeInstancesCommand: vi.fn().mockImplementation((input: unknown) => ({ __cmd: 'DescribeInstances', input })),
  CreateTagsCommand: vi.fn().mockImplementation((input: unknown) => ({ __cmd: 'CreateTags', input })),
  DeleteTagsCommand: vi.fn().mockImplementation((input: unknown) => ({ __cmd: 'DeleteTags', input })),
}));

vi.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: vi.fn().mockImplementation(() => ({ send: ssmSendMock })),
  DescribeInstanceInformationCommand: vi.fn().mockImplementation((input: unknown) => ({ __cmd: 'DescribeInstanceInformation', input })),
  SendCommandCommand: vi.fn().mockImplementation((input: unknown) => ({ __cmd: 'SendCommand', input })),
  GetCommandInvocationCommand: vi.fn().mockImplementation((input: unknown) => ({ __cmd: 'GetCommandInvocation', input })),
}));

const postAlertEmbedsMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../alerting/alertHook.js', () => ({
  postAlertEmbeds: (...args: unknown[]) => postAlertEmbedsMock(...args),
}));

const { handler } = await import('./patch-scheduler.js');

beforeEach(() => {
  ec2SendMock.mockReset();
  ssmSendMock.mockReset();
  postAlertEmbedsMock.mockClear();
});

/** An instance running for a long time (>> 30 minutes), with no pending/verified tag yet, has the schedule:start tag. */
function scheduledEligibleInstance(instanceId: string, extraTags: Array<{ Key: string; Value: string }> = []) {
  return {
    InstanceId: instanceId,
    State: { Name: 'running' },
    LaunchTime: new Date(Date.now() - 60 * 60 * 1000),
    Tags: [{ Key: 'Schedule:Start', Value: '08:00' }, ...extraTags],
  };
}

function mockDescribeInstances(instances: ReturnType<typeof scheduledEligibleInstance>[]) {
  ec2SendMock.mockImplementation((command: { __cmd: string; input?: Record<string, unknown> }) => {
    if (command.__cmd === 'DescribeInstances') return Promise.resolve({ Reservations: [{ Instances: instances }] });
    return Promise.resolve({});
  });
}

describe('patch-scheduler handler — sends SendCommand for an eligible instance, writes the command-id tag (NOT verified-date)', () => {
  it('1 eligible instance -> SendCommand AWS-RunPatchBaseline (Install, NoReboot) + CreateTags last-patch-command-id (does NOT CreateTags verified-date, since it is not yet confirmed)', async () => {
    mockDescribeInstances([scheduledEligibleInstance('i-eligible')]);
    ssmSendMock.mockImplementation((command: { __cmd: string }) => {
      if (command.__cmd === 'DescribeInstanceInformation') {
        return Promise.resolve({ InstanceInformationList: [{ InstanceId: 'i-eligible', PingStatus: 'Online' }] });
      }
      if (command.__cmd === 'SendCommand') return Promise.resolve({ Command: { CommandId: 'cmd-123' } });
      return Promise.resolve({});
    });

    const result = await handler();

    expect(result.patched).toBe(1);
    expect(result.failed).toBe(0);

    const sendCommandCall = ssmSendMock.mock.calls.find((c) => c[0].__cmd === 'SendCommand')!;
    expect(sendCommandCall[0].input.DocumentName).toBe('AWS-RunPatchBaseline');
    expect(sendCommandCall[0].input.InstanceIds).toEqual(['i-eligible']);

    const createTagsCall = ec2SendMock.mock.calls.find((c) => c[0].__cmd === 'CreateTags')!;
    expect(createTagsCall[0].input.Resources).toEqual(['i-eligible']);
    expect(createTagsCall[0].input.Tags).toEqual([{ Key: 'OpsDashboard:LastPatchCommandId', Value: 'cmd-123' }]);
  });

  it('instance does NOT have the schedule:start tag -> skipped entirely, no SendCommand', async () => {
    ec2SendMock.mockImplementation((command: { __cmd: string }) => {
      if (command.__cmd === 'DescribeInstances') {
        return Promise.resolve({
          Reservations: [{ Instances: [{ InstanceId: 'i-always-on', State: { Name: 'running' }, LaunchTime: new Date(Date.now() - 60 * 60 * 1000), Tags: [{ Key: 'Name', Value: 'always-on-server' }] }] }],
        });
      }
      return Promise.resolve({});
    });
    ssmSendMock.mockImplementation((command: { __cmd: string }) => {
      if (command.__cmd === 'DescribeInstanceInformation') return Promise.resolve({ InstanceInformationList: [{ InstanceId: 'i-always-on', PingStatus: 'Online' }] });
      return Promise.resolve({});
    });

    const result = await handler();

    expect(result.patched).toBe(0);
    expect(ssmSendMock.mock.calls.some((c) => c[0].__cmd === 'SendCommand')).toBe(false);
  });

  it('instance has the schedule:start tag but SSM is not online yet -> does not patch', async () => {
    mockDescribeInstances([scheduledEligibleInstance('i-offline')]);
    ssmSendMock.mockImplementation((command: { __cmd: string }) => {
      if (command.__cmd === 'DescribeInstanceInformation') return Promise.resolve({ InstanceInformationList: [] });
      return Promise.resolve({});
    });

    const result = await handler();
    expect(result.patched).toBe(0);
  });

  it('instance just started, not yet 30 minutes -> does not patch', async () => {
    ec2SendMock.mockImplementation((command: { __cmd: string }) => {
      if (command.__cmd === 'DescribeInstances') {
        return Promise.resolve({
          Reservations: [{ Instances: [{ InstanceId: 'i-warming', State: { Name: 'running' }, LaunchTime: new Date(Date.now() - 5 * 60 * 1000), Tags: [{ Key: 'Schedule:Start', Value: '08:00' }] }] }],
        });
      }
      return Promise.resolve({});
    });
    ssmSendMock.mockImplementation((command: { __cmd: string }) => {
      if (command.__cmd === 'DescribeInstanceInformation') return Promise.resolve({ InstanceInformationList: [{ InstanceId: 'i-warming', PingStatus: 'Online' }] });
      return Promise.resolve({});
    });

    const result = await handler();
    expect(result.patched).toBe(0);
  });

  it('SendCommand throws an error for 1 instance -> does not throw out of the handler, counted into failed, does NOT CreateTags', async () => {
    mockDescribeInstances([scheduledEligibleInstance('i-fail')]);
    ssmSendMock.mockImplementation((command: { __cmd: string }) => {
      if (command.__cmd === 'DescribeInstanceInformation') return Promise.resolve({ InstanceInformationList: [{ InstanceId: 'i-fail', PingStatus: 'Online' }] });
      if (command.__cmd === 'SendCommand') return Promise.reject(new Error('ThrottlingException'));
      return Promise.resolve({});
    });

    const result = await handler();

    expect(result.patched).toBe(0);
    expect(result.failed).toBe(1);
    expect(ec2SendMock.mock.calls.some((c) => c[0].__cmd === 'CreateTags')).toBe(false);
  });
});

describe('patch-scheduler handler — verifies the patch result via GetCommandInvocation (instance has a pending command-id from a previous run)', () => {
  it('GetCommandInvocation returns Status=Success -> writes the verified-date=today tag, counted into verified, does NOT patch again (already verified)', async () => {
    mockDescribeInstances([scheduledEligibleInstance('i-verify-ok', [{ Key: 'OpsDashboard:LastPatchCommandId', Value: 'cmd-abc' }])]);
    ssmSendMock.mockImplementation((command: { __cmd: string }) => {
      if (command.__cmd === 'DescribeInstanceInformation') return Promise.resolve({ InstanceInformationList: [{ InstanceId: 'i-verify-ok', PingStatus: 'Online' }] });
      if (command.__cmd === 'GetCommandInvocation') return Promise.resolve({ Status: 'Success' });
      return Promise.resolve({});
    });

    const result = await handler();

    expect(result.verified).toBe(1);
    expect(result.patched).toBe(0);
    const getInvocationCall = ssmSendMock.mock.calls.find((c) => c[0].__cmd === 'GetCommandInvocation')!;
    expect(getInvocationCall[0].input).toEqual({ CommandId: 'cmd-abc', InstanceId: 'i-verify-ok' });

    const createTagsCall = ec2SendMock.mock.calls.find((c) => c[0].__cmd === 'CreateTags')!;
    expect(createTagsCall[0].input.Tags[0].Key).toBe('OpsDashboard:LastPatchVerifiedDate');
  });

  it('GetCommandInvocation returns Status=Failed -> does NOT write verified-date, DELETES the command-id tag (allows patching again the same day), counted into verifyFailed', async () => {
    mockDescribeInstances([scheduledEligibleInstance('i-verify-fail', [{ Key: 'OpsDashboard:LastPatchCommandId', Value: 'cmd-bad' }])]);
    ssmSendMock.mockImplementation((command: { __cmd: string }) => {
      if (command.__cmd === 'DescribeInstanceInformation') return Promise.resolve({ InstanceInformationList: [{ InstanceId: 'i-verify-fail', PingStatus: 'Online' }] });
      if (command.__cmd === 'GetCommandInvocation') return Promise.resolve({ Status: 'Failed' });
      if (command.__cmd === 'SendCommand') return Promise.resolve({ Command: { CommandId: 'cmd-retry' } });
      return Promise.resolve({});
    });

    const result = await handler();

    expect(result.verifyFailed).toBe(1);
    const deleteTagsCall = ec2SendMock.mock.calls.find((c) => c[0].__cmd === 'DeleteTags')!;
    expect(deleteTagsCall[0].input.Resources).toEqual(['i-verify-fail']);
    expect(deleteTagsCall[0].input.Tags).toEqual([{ Key: 'OpsDashboard:LastPatchCommandId' }]);
    // the command-id was deleted -> pendingCommandDate=undefined -> eligible for patching again IMMEDIATELY within the same run.
    expect(result.patched).toBe(1);
  });

  it('GetCommandInvocation returns Status=InProgress -> does NOT write verified-date, does NOT delete command-id, does NOT patch again (still waiting), not counted into verified/verifyFailed', async () => {
    mockDescribeInstances([scheduledEligibleInstance('i-verify-pending', [{ Key: 'OpsDashboard:LastPatchCommandId', Value: 'cmd-pending' }])]);
    ssmSendMock.mockImplementation((command: { __cmd: string }) => {
      if (command.__cmd === 'DescribeInstanceInformation') return Promise.resolve({ InstanceInformationList: [{ InstanceId: 'i-verify-pending', PingStatus: 'Online' }] });
      if (command.__cmd === 'GetCommandInvocation') return Promise.resolve({ Status: 'InProgress' });
      return Promise.resolve({});
    });

    const result = await handler();

    expect(result.verified).toBe(0);
    expect(result.verifyFailed).toBe(0);
    expect(result.patched).toBe(0);
    expect(ec2SendMock.mock.calls.some((c) => c[0].__cmd === 'DeleteTags')).toBe(false);
    expect(ssmSendMock.mock.calls.some((c) => c[0].__cmd === 'SendCommand')).toBe(false);
  });

  it('already has verified-date=today (no pending command-id) -> does not call GetCommandInvocation, does not patch again', async () => {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date());
    mockDescribeInstances([scheduledEligibleInstance('i-already-verified', [{ Key: 'OpsDashboard:LastPatchVerifiedDate', Value: today }])]);
    ssmSendMock.mockImplementation((command: { __cmd: string }) => {
      if (command.__cmd === 'DescribeInstanceInformation') return Promise.resolve({ InstanceInformationList: [{ InstanceId: 'i-already-verified', PingStatus: 'Online' }] });
      return Promise.resolve({});
    });

    const result = await handler();

    expect(result.patched).toBe(0);
    expect(ssmSendMock.mock.calls.some((c) => c[0].__cmd === 'GetCommandInvocation')).toBe(false);
    expect(ssmSendMock.mock.calls.some((c) => c[0].__cmd === 'SendCommand')).toBe(false);
  });
});

describe('patch-scheduler handler — alert on error', () => {
  it('calls postAlertEmbeds when an instance fails to patch/verify', async () => {
    mockDescribeInstances([scheduledEligibleInstance('i-fail1')]);
    ssmSendMock.mockImplementation((command: { __cmd: string }) => {
      if (command.__cmd === 'DescribeInstanceInformation') {
        return Promise.resolve({ InstanceInformationList: [{ InstanceId: 'i-fail1', PingStatus: 'Online' }] });
      }
      if (command.__cmd === 'SendCommand') {
        return Promise.reject(new Error('ThrottlingException'));
      }
      return Promise.resolve({});
    });

    await handler();

    expect(postAlertEmbedsMock).toHaveBeenCalledTimes(1);
    const embeds = postAlertEmbedsMock.mock.calls[0][0];
    expect(embeds[0].title).toContain('patch-scheduler');
  });

  it('does NOT call postAlertEmbeds when everything succeeds (failed=0, verifyFailed=0)', async () => {
    mockDescribeInstances([]);
    ssmSendMock.mockResolvedValue({});

    await handler();

    expect(postAlertEmbedsMock).not.toHaveBeenCalled();
  });

  it('a patch failure names the instance (Name tag) and the actual error message, not just a count', async () => {
    mockDescribeInstances([
      {
        InstanceId: 'i-fail1',
        State: { Name: 'running' },
        LaunchTime: new Date(Date.now() - 60 * 60 * 1000),
        Tags: [{ Key: 'Schedule:Start', Value: '08:00' }, { Key: 'Name', Value: 'abc-prod-ec2-webserver' }],
      },
    ]);
    ssmSendMock.mockImplementation((command: { __cmd: string }) => {
      if (command.__cmd === 'DescribeInstanceInformation') return Promise.resolve({ InstanceInformationList: [{ InstanceId: 'i-fail1', PingStatus: 'Online' }] });
      if (command.__cmd === 'SendCommand') return Promise.reject(new Error('ThrottlingException: Rate exceeded'));
      return Promise.resolve({});
    });

    await handler();

    const embed = postAlertEmbedsMock.mock.calls[0][0][0];
    const field = embed.fields.find((f: { name: string }) => f.name === 'Failed instances');
    expect(field.value).toContain('abc-prod-ec2-webserver');
    expect(field.value).toContain('ThrottlingException: Rate exceeded');
    expect(field.value).toContain('(patch)');
  });

  it('a verify failure names the instance and the SSM terminal status', async () => {
    mockDescribeInstances([
      {
        InstanceId: 'i-verify-fail1',
        State: { Name: 'running' },
        LaunchTime: new Date(Date.now() - 60 * 60 * 1000),
        Tags: [
          { Key: 'Schedule:Start', Value: '08:00' },
          { Key: 'Name', Value: 'abc-prod-ec2-appserver' },
          { Key: 'OpsDashboard:LastPatchCommandId', Value: 'cmd-bad' },
        ],
      },
    ]);
    ssmSendMock.mockImplementation((command: { __cmd: string }) => {
      if (command.__cmd === 'DescribeInstanceInformation') return Promise.resolve({ InstanceInformationList: [{ InstanceId: 'i-verify-fail1', PingStatus: 'Online' }] });
      if (command.__cmd === 'GetCommandInvocation') return Promise.resolve({ Status: 'TimedOut' });
      if (command.__cmd === 'SendCommand') return Promise.resolve({ Command: { CommandId: 'cmd-retry' } });
      return Promise.resolve({});
    });

    await handler();

    const embed = postAlertEmbedsMock.mock.calls[0][0][0];
    const field = embed.fields.find((f: { name: string }) => f.name === 'Failed instances');
    expect(field.value).toContain('abc-prod-ec2-appserver');
    expect(field.value).toContain('TimedOut');
    expect(field.value).toContain('(verify)');
  });

  it('an instance with no Name tag falls back to the raw instanceId in the failure list', async () => {
    mockDescribeInstances([scheduledEligibleInstance('i-no-name-tag')]);
    ssmSendMock.mockImplementation((command: { __cmd: string }) => {
      if (command.__cmd === 'DescribeInstanceInformation') return Promise.resolve({ InstanceInformationList: [{ InstanceId: 'i-no-name-tag', PingStatus: 'Online' }] });
      if (command.__cmd === 'SendCommand') return Promise.reject(new Error('AccessDenied'));
      return Promise.resolve({});
    });

    await handler();

    const embed = postAlertEmbedsMock.mock.calls[0][0][0];
    const field = embed.fields.find((f: { name: string }) => f.name === 'Failed instances');
    expect(field.value).toContain('i-no-name-tag');
  });
});
