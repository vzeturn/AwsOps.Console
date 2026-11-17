import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * `config.ts` reads `window.__APP_CONFIG__` at MODULE-EVALUATION time (not lazily) and throws if it
 * is missing — so it has to be set up before `api/client.ts` (which imports `config.ts`) is ever
 * imported. Done once, at the top of this file, rather than per-test: nothing here mutates it.
 */
window.__APP_CONFIG__ = {
  entraAuthority: 'https://login.microsoftonline.com/tenant/v2.0',
  entraClientId: 'client-id',
  apiBaseUrl: 'https://router.example.com',
  redirectUri: 'https://app.example.com',
  scope: 'openid profile email offline_access',
};

const { api, ApiError } = await import('./client');

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('api client — request()', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('sends the bearer token and calls the correct path under apiBaseUrl', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, { sub: '1', name: 'A', email: 'a@b.com', isOperator: false }));

    await api.me('token-123');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://router.example.com/me',
      expect.objectContaining({ headers: expect.objectContaining({ authorization: 'Bearer token-123' }) }),
    );
  });

  it('parses the RFC 9457 problem+json "detail" field into the thrown ApiError message', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(403, { type: 'about:blank', title: 'Forbidden', status: 403, detail: 'Account is not a member of the operator group' }),
    );

    await expect(api.infra('token')).rejects.toMatchObject({
      status: 403,
      message: 'Account is not a member of the operator group',
    });
  });

  it('falls back to the legacy "error" field when "detail" is absent (backward compatibility)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(400, { error: 'legacy shape' }));

    await expect(api.infra('token')).rejects.toMatchObject({ status: 400, message: 'legacy shape' });
  });

  it('falls back to the raw statusText when the error body has no usable message field at all', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('not json', { status: 500, statusText: 'Internal Server Error' }));

    await expect(api.infra('token')).rejects.toMatchObject({ status: 500, message: 'Internal Server Error' });
  });

  it('rejected requests throw an instance of ApiError specifically, not a generic Error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(401, { detail: 'Unauthorized' }));

    await expect(api.infra('token')).rejects.toBeInstanceOf(ApiError);
  });
});

describe('api client — query-string builders', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('logEvents encodes required + optional params, omitting filterPattern/nextToken when absent', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, { events: [], truncatedMessageCount: 0 }));

    await api.logEvents('token', { logGroupName: '/aws/lambda/router', startTime: 1000, endTime: 2000 });

    const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(calledUrl.pathname).toBe('/logs/events');
    expect(calledUrl.searchParams.get('logGroupName')).toBe('/aws/lambda/router');
    expect(calledUrl.searchParams.get('startTime')).toBe('1000');
    expect(calledUrl.searchParams.get('endTime')).toBe('2000');
    expect(calledUrl.searchParams.has('filterPattern')).toBe(false);
    expect(calledUrl.searchParams.has('nextToken')).toBe(false);
  });

  it('logEvents includes filterPattern and nextToken when both are provided', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, { events: [], truncatedMessageCount: 0 }));

    await api.logEvents('token', {
      logGroupName: '/aws/lambda/router',
      startTime: 1000,
      endTime: 2000,
      filterPattern: 'ERROR',
      nextToken: 'abc',
    });

    const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(calledUrl.searchParams.get('filterPattern')).toBe('ERROR');
    expect(calledUrl.searchParams.get('nextToken')).toBe('abc');
  });

  it('actionsAudit URL-encodes resourceType and resourceId', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, []));

    await api.actionsAudit('token', 'ec2', 'i-abc 123');

    const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(calledUrl.searchParams.get('resourceType')).toBe('ec2');
    expect(calledUrl.searchParams.get('resourceId')).toBe('i-abc 123');
  });
});

describe('api client — POST bodies', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('actionsRunCommand POSTs the body as JSON with the correct path', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(200, { outcome: 'success', commandId: 'cmd-1' }));

    const body = { actionType: 'SSM_RunPreset' as const, resourceId: 'i-abc123', region: 'ap-southeast-1', params: { presetId: 'disk-usage' } };
    const result = await api.actionsRunCommand('token', body);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://router.example.com/actions/run-command',
      expect.objectContaining({ method: 'POST', body: JSON.stringify(body) }),
    );
    expect(result.commandId).toBe('cmd-1');
  });

  it('deleteSchedule resolves without a value on success (requestVoid does not attempt to parse a body)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));

    await expect(api.deleteSchedule('token', 'abc-prod-downsize-20260101-0000-abcd')).resolves.toBeUndefined();
  });
});
