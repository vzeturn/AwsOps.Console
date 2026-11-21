import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.ALERT_HOOK_URL_PARAM_NAME = '/abc/ops-dashboard/prod/alert-hook-url';

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

const { postAlertEmbeds } = await import('./alertHook.js');

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
  ssmSendMock.mockResolvedValue({ Parameter: { Value: 'https://rt.example.test/hooks/alert/test-token' } });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
});

describe('postAlertEmbeds — structured logging for later analysis', () => {
  it('logs a "alert-notification" record for each embed, BEFORE attempting the POST', async () => {
    await postAlertEmbeds([buildEmbed({ title: 'A' }), buildEmbed({ title: 'B' })]);

    expect(loggerInfoMock).toHaveBeenCalledTimes(2);
    expect(loggerInfoMock.mock.calls[0][0]).toBe('alert-notification');
    expect(loggerInfoMock.mock.calls[0][1]).toMatchObject({ title: 'A' });
    expect(loggerInfoMock.mock.calls[1][1]).toMatchObject({ title: 'B' });
  });

  it('maps color 0xed4245 (critical) to severity="critical"', async () => {
    await postAlertEmbeds([buildEmbed({ color: 0xed4245 })]);
    expect(loggerInfoMock.mock.calls[0][1]).toMatchObject({ severity: 'critical' });
  });

  it('maps color 0xfaa61a (warning) to severity="warning"', async () => {
    await postAlertEmbeds([buildEmbed({ color: 0xfaa61a })]);
    expect(loggerInfoMock.mock.calls[0][1]).toMatchObject({ severity: 'warning' });
  });

  it('maps color 0x57f287 (success) to severity="success"', async () => {
    await postAlertEmbeds([buildEmbed({ color: 0x57f287 })]);
    expect(loggerInfoMock.mock.calls[0][1]).toMatchObject({ severity: 'success' });
  });

  it('maps color 0x5865f2 (info) to severity="info"', async () => {
    await postAlertEmbeds([buildEmbed({ color: 0x5865f2 })]);
    expect(loggerInfoMock.mock.calls[0][1]).toMatchObject({ severity: 'info' });
  });

  it('an unrecognized color still logs, with a fallback severity label instead of throwing', async () => {
    await postAlertEmbeds([buildEmbed({ color: 0x123456 })]);
    expect(loggerInfoMock.mock.calls[0][1]).toMatchObject({ severity: 'unknown(1193046)' });
  });

  it('includes the field NAMES (not full values) and the footer text', async () => {
    await postAlertEmbeds([
      buildEmbed({ fields: [{ name: '🎯 Impact', value: 'some long impact text', inline: false }, { name: 'Who', value: 'system:x', inline: true }] }),
    ]);
    expect(loggerInfoMock.mock.calls[0][1]).toMatchObject({
      fieldNames: ['🎯 Impact', 'Who'],
      footer: 'ops-dashboard · Test',
    });
  });

  it('still logs the notification-sent record even when the alert hub POST itself fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, text: () => Promise.resolve('server error') }));
    await postAlertEmbeds([buildEmbed()]);

    expect(loggerInfoMock).toHaveBeenCalledTimes(1);
    expect(loggerInfoMock.mock.calls[0][0]).toBe('alert-notification');
    expect(loggerErrorMock).toHaveBeenCalledTimes(1); // the POST failure is still logged separately, as before.
  });

  it('still logs the notification-sent record even when fetching the webhook URL from SSM fails', async () => {
    // `alertHook.ts` caches a SUCCESSFUL webhook URL at module scope across calls within the
    // same execution environment (see its own file header) — a prior test in this file already
    // populated that cache with a successful SSM read, so this test must reset the module to get
    // a fresh, uncached client that will actually call SSM again.
    vi.resetModules();
    ssmSendMock.mockReset();
    ssmSendMock.mockRejectedValue(new Error('AccessDenied'));
    const fresh = await import('./alertHook.js');
    await fresh.postAlertEmbeds([buildEmbed()]);

    expect(loggerInfoMock).toHaveBeenCalledTimes(1);
    expect(loggerErrorMock).toHaveBeenCalledTimes(1);
  });

  it('logs nothing when called with an empty array (nothing to send)', async () => {
    await postAlertEmbeds([]);
    expect(loggerInfoMock).not.toHaveBeenCalled();
  });
});

describe('postAlertEmbeds — hub delivery', () => {
  it('POSTs a critical embed to the hook URL from SSM as {severity,title,text,tenant}', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    await postAlertEmbeds([
      buildEmbed({ title: 'Disk full', color: 0xed4245, fields: [{ name: 'Where', value: 'db-1' }], timestamp: '2026-11-21T00:00:00.000Z' }),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('https://rt.example.test/hooks/alert/test-token');
    expect(options.method).toBe('POST');
    expect(options.headers).toMatchObject({ 'content-type': 'application/json' });
    const body = JSON.parse(options.body);
    expect(Object.keys(body).sort()).toEqual(['severity', 'tenant', 'text', 'title']);
    expect(body).toMatchObject({ severity: 'critical', title: 'Disk full', tenant: '' });
    expect(body.text).toContain('**Where**\ndb-1');
    expect(body.text).toContain('ops-dashboard · Test · 2026-11-21T00:00:00.000Z');
  });

  it('POSTs a warning embed with severity "warning"', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    await postAlertEmbeds([buildEmbed({ color: 0xfaa61a })]);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).severity).toBe('warning');
  });

  it('success, info and unknown colors are logged only, never POSTed (and SSM is not read)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    await postAlertEmbeds([buildEmbed({ color: 0x57f287 }), buildEmbed({ color: 0x5865f2 }), buildEmbed({ color: 0x123456 })]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ssmSendMock).not.toHaveBeenCalled();
    expect(loggerInfoMock.mock.calls.map((c) => c[1].delivery)).toEqual(['log-only', 'log-only', 'log-only']);
  });

  it('a non-2xx hub response is logged as an error and does not throw', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, text: () => Promise.resolve('boom') }));
    await expect(postAlertEmbeds([buildEmbed()])).resolves.toBeUndefined();
    expect(loggerErrorMock).toHaveBeenCalledTimes(1);
  });
});

describe('postAlertEmbeds — logOnly option', () => {
  it('logOnly never POSTs, even a critical embed', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    await postAlertEmbeds([buildEmbed({ color: 0xed4245 })], { logOnly: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(loggerInfoMock.mock.calls[0][1]).toMatchObject({ severity: 'critical', delivery: 'log-only' });
  });
});
