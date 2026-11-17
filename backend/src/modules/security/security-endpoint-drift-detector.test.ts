import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.AWS_REGION = 'ap-southeast-1';

const ec2SendMock = vi.fn();
const ssmSendMock = vi.fn();

vi.mock('@aws-sdk/client-ec2', () => ({
  EC2Client: vi.fn().mockImplementation(() => ({ send: ec2SendMock })),
  DescribeInstancesCommand: vi.fn().mockImplementation((input: unknown) => ({ __cmd: 'DescribeInstances', input })),
}));
vi.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: vi.fn().mockImplementation(() => ({ send: ssmSendMock })),
  DescribeInstanceInformationCommand: vi.fn().mockImplementation((input: unknown) => ({ __cmd: 'DescribeInstanceInformation', input })),
  SendCommandCommand: vi.fn().mockImplementation((input: unknown) => ({ __cmd: 'SendCommand', input })),
  GetCommandInvocationCommand: vi.fn().mockImplementation((input: unknown) => ({ __cmd: 'GetCommandInvocation', input })),
}));

const postDiscordEmbedsMock = vi.fn();
vi.mock('../alerting/discordWebhook.js', () => ({ postDiscordEmbeds: postDiscordEmbedsMock }));

const { handler, parseDetectedProcesses } = await import('./security-endpoint-drift-detector.js');

beforeEach(() => {
  ec2SendMock.mockReset();
  ssmSendMock.mockReset();
  postDiscordEmbedsMock.mockReset();
  vi.useRealTimers();
});

describe('parseDetectedProcesses', () => {
  it('extracts only the patterns with a non-zero count', () => {
    const stdout = 'tailscaled:1\nnetbird:1\ncloudflared:0';
    expect(parseDetectedProcesses(stdout)).toEqual(['tailscaled', 'netbird']);
  });

  it('returns an empty list when nothing was found', () => {
    expect(parseDetectedProcesses('tailscaled:0\nnetbird:0\ncloudflared:0')).toEqual([]);
  });

  it('ignores lines that are not one of the watched patterns (tolerant of noise)', () => {
    expect(parseDetectedProcesses('garbage line\ntailscaled:1')).toEqual(['tailscaled']);
  });
});

describe('handler', () => {
  // The poll loop's `setTimeout` delays are real wall-clock time (2s x up to 6 attempts). Every
  // scenario below resolves `Success` on the FIRST GetCommandInvocation call, so each test only
  // pays for exactly 1 delay (2s) — not faking timers here because `setTimeout` inside a
  // Promise-based async loop deadlocks under fake timers unless every advance is manually driven,
  // which would make these tests more fragile than the 2s they'd save.

  it('reports an unexplained finding (no SecurityException tag) at warning severity', async () => {
    ssmSendMock.mockImplementation((command: { __cmd: string }) => {
      if (command.__cmd === 'DescribeInstanceInformation') {
        return Promise.resolve({ InstanceInformationList: [{ InstanceId: 'i-0a1b2c3d4e5f60004', PingStatus: 'Online' }] });
      }
      if (command.__cmd === 'SendCommand') return Promise.resolve({ Command: { CommandId: 'cmd-1' } });
      if (command.__cmd === 'GetCommandInvocation') {
        return Promise.resolve({ Status: 'Success', StandardOutputContent: 'tailscaled:1\nnetbird:1\ncloudflared:0' });
      }
      return Promise.resolve({});
    });
    ec2SendMock.mockResolvedValue({ Reservations: [{ Instances: [{ InstanceId: 'i-0a1b2c3d4e5f60004', Tags: [] }] }] });

    const result = await handler();

    expect(result).toEqual({ ok: true, scanned: 1, withDrift: 1, unexplained: 1 });
    expect(postDiscordEmbedsMock).toHaveBeenCalledTimes(1);
    const embed = postDiscordEmbedsMock.mock.calls[0][0][0];
    expect(embed.color).toBe(0xfaa61a); // warning
    expect(JSON.stringify(embed)).toContain('NOT tagged as an exception');
  });

  it('reports a sanctioned finding (has SecurityException tag) at info severity', async () => {
    ssmSendMock.mockImplementation((command: { __cmd: string }) => {
      if (command.__cmd === 'DescribeInstanceInformation') {
        return Promise.resolve({ InstanceInformationList: [{ InstanceId: 'i-tagged', PingStatus: 'Online' }] });
      }
      if (command.__cmd === 'SendCommand') return Promise.resolve({ Command: { CommandId: 'cmd-1' } });
      if (command.__cmd === 'GetCommandInvocation') return Promise.resolve({ Status: 'Success', StandardOutputContent: 'tailscaled:1\nnetbird:0\ncloudflared:0' });
      return Promise.resolve({});
    });
    ec2SendMock.mockResolvedValue({ Reservations: [{ Instances: [{ InstanceId: 'i-tagged', Tags: [{ Key: 'SecurityException', Value: 'dual-vpn' }] }] }] });

    const result = await handler();

    expect(result).toEqual({ ok: true, scanned: 1, withDrift: 1, unexplained: 0 });
    const embed = postDiscordEmbedsMock.mock.calls[0][0][0];
    expect(embed.color).toBe(0x5865f2); // info
    expect(JSON.stringify(embed)).toContain('sanctioned');
  });

  it('does not post anything when no watched process is found on any instance', async () => {
    ssmSendMock.mockImplementation((command: { __cmd: string }) => {
      if (command.__cmd === 'DescribeInstanceInformation') return Promise.resolve({ InstanceInformationList: [{ InstanceId: 'i-clean', PingStatus: 'Online' }] });
      if (command.__cmd === 'SendCommand') return Promise.resolve({ Command: { CommandId: 'cmd-1' } });
      if (command.__cmd === 'GetCommandInvocation') return Promise.resolve({ Status: 'Success', StandardOutputContent: 'tailscaled:0\nnetbird:0\ncloudflared:0' });
      return Promise.resolve({});
    });
    ec2SendMock.mockResolvedValue({ Reservations: [{ Instances: [{ InstanceId: 'i-clean', Tags: [] }] }] });

    const result = await handler();

    expect(result).toEqual({ ok: true, scanned: 1, withDrift: 0, unexplained: 0 });
    expect(postDiscordEmbedsMock).not.toHaveBeenCalled();
  });

  it('skips an instance with no SSM agent online (nothing to scan)', async () => {
    ssmSendMock.mockImplementation((command: { __cmd: string }) => {
      if (command.__cmd === 'DescribeInstanceInformation') return Promise.resolve({ InstanceInformationList: [] });
      return Promise.resolve({});
    });

    const result = await handler();

    expect(result).toEqual({ ok: true, scanned: 0, withDrift: 0, unexplained: 0 });
    expect(ec2SendMock).not.toHaveBeenCalled();
  });

  it('treats an SSM command failure as skipped (never throws, never flagged)', async () => {
    ssmSendMock.mockImplementation((command: { __cmd: string }) => {
      if (command.__cmd === 'DescribeInstanceInformation') return Promise.resolve({ InstanceInformationList: [{ InstanceId: 'i-broken', PingStatus: 'Online' }] });
      if (command.__cmd === 'SendCommand') return Promise.reject(new Error('ThrottlingException'));
      return Promise.resolve({});
    });
    ec2SendMock.mockResolvedValue({ Reservations: [{ Instances: [{ InstanceId: 'i-broken', Tags: [] }] }] });

    const result = await handler();

    expect(result).toEqual({ ok: true, scanned: 1, withDrift: 0, unexplained: 0 });
    expect(postDiscordEmbedsMock).not.toHaveBeenCalled();
  });
});
