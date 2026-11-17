import { describe, it, expect, vi, beforeEach } from 'vitest';

const ssmSendMock = vi.fn();

vi.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: vi.fn().mockImplementation(() => ({ send: ssmSendMock })),
  GetParameterCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'GetParameter', input })),
}));

beforeEach(() => {
  ssmSendMock.mockReset();
  vi.resetModules();
});

describe('isAgentAutoExecuteEnabled', () => {
  it('returns true only when the parameter value is exactly "true"', async () => {
    process.env.AGENT_KILL_SWITCH_PARAM_NAME = 'test-kill-switch-param';
    ssmSendMock.mockResolvedValue({ Parameter: { Value: 'true' } });
    const { isAgentAutoExecuteEnabled } = await import('./agentKillSwitch.js');

    expect(await isAgentAutoExecuteEnabled()).toBe(true);
  });

  it('returns false when the parameter value is any other string ("True", "1", "yes", " true ")', async () => {
    process.env.AGENT_KILL_SWITCH_PARAM_NAME = 'test-kill-switch-param';
    for (const value of ['True', 'TRUE', '1', 'yes', 'enabled']) {
      vi.resetModules();
      ssmSendMock.mockReset();
      ssmSendMock.mockResolvedValue({ Parameter: { Value: value } });
      const { isAgentAutoExecuteEnabled } = await import('./agentKillSwitch.js');
      expect(await isAgentAutoExecuteEnabled()).toBe(false);
    }
  });

  it('tolerates surrounding whitespace around the exact value "true"', async () => {
    process.env.AGENT_KILL_SWITCH_PARAM_NAME = 'test-kill-switch-param';
    ssmSendMock.mockResolvedValue({ Parameter: { Value: '  true  ' } });
    const { isAgentAutoExecuteEnabled } = await import('./agentKillSwitch.js');

    expect(await isAgentAutoExecuteEnabled()).toBe(true);
  });

  it('returns false when the parameter has no value', async () => {
    process.env.AGENT_KILL_SWITCH_PARAM_NAME = 'test-kill-switch-param';
    ssmSendMock.mockResolvedValue({ Parameter: {} });
    const { isAgentAutoExecuteEnabled } = await import('./agentKillSwitch.js');

    expect(await isAgentAutoExecuteEnabled()).toBe(false);
  });

  it('returns false (fail-safe) when GetParameter throws', async () => {
    process.env.AGENT_KILL_SWITCH_PARAM_NAME = 'test-kill-switch-param';
    ssmSendMock.mockRejectedValue(new Error('AccessDenied'));
    const { isAgentAutoExecuteEnabled } = await import('./agentKillSwitch.js');

    expect(await isAgentAutoExecuteEnabled()).toBe(false);
  });

  it('returns false (fail-safe) when AGENT_KILL_SWITCH_PARAM_NAME is not configured, without calling SSM', async () => {
    delete process.env.AGENT_KILL_SWITCH_PARAM_NAME;
    const { isAgentAutoExecuteEnabled } = await import('./agentKillSwitch.js');

    expect(await isAgentAutoExecuteEnabled()).toBe(false);
    expect(ssmSendMock).not.toHaveBeenCalled();
  });

  it('reads SSM fresh on every call — no cross-call caching', async () => {
    process.env.AGENT_KILL_SWITCH_PARAM_NAME = 'test-kill-switch-param';
    ssmSendMock.mockResolvedValueOnce({ Parameter: { Value: 'true' } }).mockResolvedValueOnce({ Parameter: { Value: 'false' } });
    const { isAgentAutoExecuteEnabled } = await import('./agentKillSwitch.js');

    expect(await isAgentAutoExecuteEnabled()).toBe(true);
    expect(await isAgentAutoExecuteEnabled()).toBe(false);
    expect(ssmSendMock).toHaveBeenCalledTimes(2);
  });
});
