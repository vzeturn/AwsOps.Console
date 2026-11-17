import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildAppConfig, renderConfigJs, REQUIRED_SCOPE } from './generate-config.mjs';

/** Vitest runs with the frontend workspace as cwd. */
const FRONTEND_ROOT = process.cwd();
const STATIC_SERVER = path.join(FRONTEND_ROOT, '..', 'infra', 'static-server', 'index.ts');
const APP_CONFIG_TS = path.join(FRONTEND_ROOT, 'src', 'config.ts');

const VALID_ENV = {
  ENTRA_TENANT_ID: '11111111-2222-3333-4444-555555555555',
  ENTRA_CLIENT_ID: '66666666-7777-8888-9999-000000000000',
  API_BASE_URL: 'https://router.lambda-url.ap-southeast-1.on.aws/',
  SITE_URL: 'https://ops-dashboard.example.workers.dev',
};

describe('buildAppConfig', () => {
  it('produces exactly the fields declared by the AppConfig interface the app reads', () => {
    // Parse the field names straight out of `frontend/src/config.ts` rather than hardcoding them, so
    // adding a field to AppConfig without teaching this generator about it fails HERE instead of at
    // runtime as `undefined` inside the SPA.
    const source = readFileSync(APP_CONFIG_TS, 'utf8');
    const body = source.match(/interface AppConfig \{([\s\S]*?)\}/);
    expect(body, 'could not locate the AppConfig interface in src/config.ts').not.toBeNull();
    const declared = [...body[1].matchAll(/^\s*(\w+)\s*:/gm)].map((m) => m[1]).sort();
    expect(Object.keys(buildAppConfig(VALID_ENV)).sort()).toEqual(declared);
  });

  it('maps each env var to the right field', () => {
    expect(buildAppConfig(VALID_ENV)).toEqual({
      entraAuthority: `https://login.microsoftonline.com/${VALID_ENV.ENTRA_TENANT_ID}/v2.0`,
      entraClientId: VALID_ENV.ENTRA_CLIENT_ID,
      // API_BASE_URL in VALID_ENV intentionally has the trailing slash a real Lambda Function URL has.
      apiBaseUrl: 'https://router.lambda-url.ap-southeast-1.on.aws',
      redirectUri: VALID_ENV.SITE_URL,
      scope: REQUIRED_SCOPE,
    });
  });

  /**
   * `api/client.ts` builds every request as `${apiBaseUrl}${path}` with `path` already starting with
   * "/", so a trailing slash here yields `https://host//me`.
   */
  it('strips trailing slashes so request URLs do not end up with a double slash', () => {
    const cfg = buildAppConfig({ ...VALID_ENV, API_BASE_URL: 'https://api.example/', SITE_URL: 'https://site.example/' });
    expect(cfg.apiBaseUrl).toBe('https://api.example');
    expect(cfg.redirectUri).toBe('https://site.example');
    expect(`${cfg.apiBaseUrl}/me`).toBe('https://api.example/me');
  });

  it.each(['ENTRA_TENANT_ID', 'ENTRA_CLIENT_ID', 'API_BASE_URL', 'SITE_URL'])(
    'fails loud when %s is missing instead of emitting a broken config',
    (name) => {
      const env = { ...VALID_ENV };
      delete env[name];
      expect(() => buildAppConfig(env)).toThrow(name);
    },
  );

  it('treats a whitespace-only value as missing', () => {
    expect(() => buildAppConfig({ ...VALID_ENV, API_BASE_URL: '   ' })).toThrow('API_BASE_URL');
  });
});

describe('scope — the field with a production incident behind it', () => {
  it('requests offline_access (without it, token renewal silently dies after ~60 min)', () => {
    expect(REQUIRED_SCOPE.split(' ')).toContain('offline_access');
  });

  it('does NOT request the API scope (Entra would return a Graph token and drop ours)', () => {
    expect(REQUIRED_SCOPE).not.toMatch(/api:\/\//);
    expect(REQUIRED_SCOPE).not.toMatch(/access_as_user/);
  });
});

/**
 * ANTI-DRIFT. Two deployments currently serve this SPA and each builds `config.js` its own way:
 * the `static-server` Lambda synthesizes it per-request, this script writes it at build time. They
 * must agree, otherwise sign-in works on one origin and mysteriously fails on the other. When the
 * Lambda is eventually deleted, delete this block with it.
 */
describe('parity with the static-server Lambda', () => {
  const lambdaSource = readFileSync(STATIC_SERVER, 'utf8');

  it('uses the identical scope string', () => {
    const found = lambdaSource.match(/scope:\s*'([^']+)'/);
    expect(found, 'could not find the scope literal in infra/static-server/index.ts').not.toBeNull();
    expect(found[1]).toBe(REQUIRED_SCOPE);
  });

  it('sets the identical set of config keys', () => {
    for (const key of Object.keys(buildAppConfig(VALID_ENV))) {
      expect(lambdaSource, `static-server/index.ts does not set "${key}"`).toContain(`${key}:`);
    }
  });

  it('assigns window.__APP_CONFIG__ the same way', () => {
    expect(lambdaSource).toContain('window.__APP_CONFIG__ =');
    expect(renderConfigJs(buildAppConfig(VALID_ENV))).toMatch(/^window\.__APP_CONFIG__ = \{/);
  });
});

describe('renderConfigJs', () => {
  it('emits a single assignment that parses as JS and round-trips the config', () => {
    const config = buildAppConfig(VALID_ENV);
    const scope = {};
    new Function('window', renderConfigJs(config))(scope);
    expect(scope.__APP_CONFIG__).toEqual(config);
  });
});
