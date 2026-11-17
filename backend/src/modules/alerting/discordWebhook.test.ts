import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.DISCORD_WEBHOOK_URL_PARAM_NAME = '/abc/ops-dashboard/prod/discord-webhook-url';

const ssmSendMock = vi.fn();
vi.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: vi.fn().mockImplementation(() => ({ send: ssmSendMock })),
  GetParameterCommand: vi.fn().mockImplementation((input: unknown) => ({ __cmd: 'GetParameter', input })),
}));

const loggerInfoMock = vi.fn();
const loggerErrorMock = vi.fn();
vi.mock('../../shared-kernel/logger.js', () => ({
  logger: { info: (...args: unknown[]) => loggerInfoMock(...args), error: (...args: unknown[]) => loggerErrorMock(...args), warn: vi.fn() },
}));

const { postDiscordEmbeds } = await import('./discordWebhook.js');

function buildEmbed(overrides: Partial<{ title: string; color: number; footer: { text: string }; fields: { name: string; value: string; inline?: boolean }[]; timestamp: string }> = {}) {
  return {
    title: 'Test embed',
    color: 0xed4245,
    fields: [{ name: 'Where', value: 'x', inline: true }],
    footer: { text: 'ops-dashboard · Test' },
    ...overrides,
  };
}

beforeEach(() => {
  ssmSendMock.mockReset();
  loggerInfoMock.mockClear();
  loggerErrorMock.mockClear();
  ssmSendMock.mockResolvedValue({ Parameter: { Value: 'https://discord.com/api/webhooks/test-id/test-token' } });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
});

describe('postDiscordEmbeds — structured logging for later analysis', () => {
  it('logs a "discord-notification-sent" record for each embed, BEFORE attempting the POST', async () => {
    await postDiscordEmbeds([buildEmbed({ title: 'A' }), buildEmbed({ title: 'B' })]);

    expect(loggerInfoMock).toHaveBeenCalledTimes(2);
    expect(loggerInfoMock.mock.calls[0][0]).toBe('discord-notification-sent');
    expect(loggerInfoMock.mock.calls[0][1]).toMatchObject({ title: 'A' });
    expect(loggerInfoMock.mock.calls[1][1]).toMatchObject({ title: 'B' });
  });

  it('maps color 0xed4245 (critical) to severity="critical"', async () => {
    await postDiscordEmbeds([buildEmbed({ color: 0xed4245 })]);
    expect(loggerInfoMock.mock.calls[0][1]).toMatchObject({ severity: 'critical' });
  });

  it('maps color 0xfaa61a (warning) to severity="warning"', async () => {
    await postDiscordEmbeds([buildEmbed({ color: 0xfaa61a })]);
    expect(loggerInfoMock.mock.calls[0][1]).toMatchObject({ severity: 'warning' });
  });

  it('maps color 0x57f287 (success) to severity="success"', async () => {
    await postDiscordEmbeds([buildEmbed({ color: 0x57f287 })]);
    expect(loggerInfoMock.mock.calls[0][1]).toMatchObject({ severity: 'success' });
  });

  it('maps color 0x5865f2 (info) to severity="info"', async () => {
    await postDiscordEmbeds([buildEmbed({ color: 0x5865f2 })]);
    expect(loggerInfoMock.mock.calls[0][1]).toMatchObject({ severity: 'info' });
  });

  it('an unrecognized color still logs, with a fallback severity label instead of throwing', async () => {
    await postDiscordEmbeds([buildEmbed({ color: 0x123456 })]);
    expect(loggerInfoMock.mock.calls[0][1]).toMatchObject({ severity: 'unknown(1193046)' });
  });

  it('includes the field NAMES (not full values) and the footer text', async () => {
    await postDiscordEmbeds([
      buildEmbed({ fields: [{ name: '🎯 Impact', value: 'some long impact text', inline: false }, { name: 'Who', value: 'system:x', inline: true }] }),
    ]);
    expect(loggerInfoMock.mock.calls[0][1]).toMatchObject({
      fieldNames: ['🎯 Impact', 'Who'],
      footer: 'ops-dashboard · Test',
    });
  });

  it('still logs the notification-sent record even when the Discord POST itself fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, text: () => Promise.resolve('server error') }));
    await postDiscordEmbeds([buildEmbed()]);

    expect(loggerInfoMock).toHaveBeenCalledTimes(1);
    expect(loggerInfoMock.mock.calls[0][0]).toBe('discord-notification-sent');
    expect(loggerErrorMock).toHaveBeenCalledTimes(1); // the POST failure is still logged separately, as before.
  });

  it('still logs the notification-sent record even when fetching the webhook URL from SSM fails', async () => {
    // `discordWebhook.ts` caches a SUCCESSFUL webhook URL at module scope across calls within the
    // same execution environment (see its own file header) — a prior test in this file already
    // populated that cache with a successful SSM read, so this test must reset the module to get
    // a fresh, uncached client that will actually call SSM again.
    vi.resetModules();
    ssmSendMock.mockReset();
    ssmSendMock.mockRejectedValue(new Error('AccessDenied'));
    const fresh = await import('./discordWebhook.js');
    await fresh.postDiscordEmbeds([buildEmbed()]);

    expect(loggerInfoMock).toHaveBeenCalledTimes(1);
    expect(loggerErrorMock).toHaveBeenCalledTimes(1);
  });

  it('logs nothing when called with an empty array (nothing to send)', async () => {
    await postDiscordEmbeds([]);
    expect(loggerInfoMock).not.toHaveBeenCalled();
  });
});
