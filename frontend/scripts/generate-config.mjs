#!/usr/bin/env node
/**
 * Generates `dist/config.js` — the `window.__APP_CONFIG__` block that `frontend/src/config.ts` reads
 * at startup (before `main.tsx` runs).
 *
 * WHY THIS EXISTS: on the Lambda deployment this file does not exist on disk at all — the
 * `static-server` Lambda synthesizes it per-request from its own environment variables (see
 * `infra/static-server/index.ts`, `configJs()`). Cloudflare Workers static assets serves files, it
 * does not run code (that is the entire point — asset-only serving is not billable), so the same
 * content has to be produced at BUILD time instead.
 *
 * Every value here is PUBLIC by nature: they end up in a JS file downloaded by every browser that
 * loads the SPA. A tenant ID, a SPA client ID (PKCE, no secret), an API URL and a redirect URI are
 * not secrets. Do NOT add anything that is.
 *
 * KEEP IN SYNC with `infra/static-server/index.ts` for as long as BOTH deployments exist. The
 * duplication is deliberate and temporary: it lets the Lambda and Cloudflare versions run in
 * parallel so they can be compared and rolled back. `generate-config.test.mjs` pins the output shape
 * and the exact `scope` string so the two cannot drift silently.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * `offline_access` IS REQUIRED, and the API scope MUST NOT be added. Both rules are the outcome of
 * production incidents — the full reasoning lives in `infra/static-server/index.ts` and
 * `frontend/src/auth/oidcConfig.ts`. In short:
 *
 *  - WITHOUT `offline_access`, Entra ID issues no refresh token, `automaticSilentRenew` falls back to
 *    a hidden iframe against login.microsoftonline.com, modern browsers block third-party cookies in
 *    that iframe, renewal fails SILENTLY, and ~60-90 minutes later every tab shows "Unauthorized"
 *    until the user reloads by hand.
 *  - WITH `api://<clientId>/access_as_user` added here, the request asks for tokens for TWO
 *    resources at once; Entra issues an access token for only ONE, picks Microsoft Graph, and
 *    silently drops our scope — the backend then rejects every request. This was tried once and
 *    reverted (see infra/static-server/index.ts's `configJs()` for the full incident history).
 */
export const REQUIRED_SCOPE = 'openid profile email offline_access';

/** Env vars that must be present. Named exactly like the `static-server` Lambda's own variables. */
const REQUIRED_ENV = ['ENTRA_TENANT_ID', 'ENTRA_CLIENT_ID', 'API_BASE_URL', 'SITE_URL'];

export function buildAppConfig(env) {
  const missing = REQUIRED_ENV.filter((name) => !env[name] || String(env[name]).trim() === '');
  if (missing.length > 0) {
    throw new Error(
      `generate-config: missing required environment variable(s): ${missing.join(', ')}. ` +
        'Run this through infra/deploy-frontend-cloudflare.sh, which reads API_BASE_URL from the ' +
        'CloudFormation stack outputs — do not hand-build dist/config.js.',
    );
  }
  return {
    entraAuthority: `https://login.microsoftonline.com/${env.ENTRA_TENANT_ID}/v2.0`,
    entraClientId: env.ENTRA_CLIENT_ID,
    // Trailing slash stripped. `API_BASE_URL` comes from the CloudFormation `RouterFunctionUrl`
    // output, and a Lambda Function URL always ends in "/". `api/client.ts` builds requests as
    // `${apiBaseUrl}${path}` where path already starts with "/", so leaving it produces
    // `https://host//me`. That still routes correctly (the router's `splitPath` drops empty segments)
    // but it shows up in every browser devtools entry and CORS error message, which sends people
    // debugging the wrong thing.
    apiBaseUrl: String(env.API_BASE_URL).replace(/\/+$/, ''),
    redirectUri: String(env.SITE_URL).replace(/\/+$/, ''),
    scope: REQUIRED_SCOPE,
  };
}

export function renderConfigJs(config) {
  return `window.__APP_CONFIG__ = ${JSON.stringify(config)};\n`;
}

// Only run when executed directly, so the test can import the pure functions above.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  const outDir = process.argv[2] ?? 'dist';
  const config = buildAppConfig(process.env);
  const outFile = path.join(outDir, 'config.js');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(outFile, renderConfigJs(config), 'utf8');
  // Deliberately does NOT print the values: harmless here, but keeps CI logs free of tenant/client
  // IDs that reviewers would then have to redact from pasted output.
  console.log(`generate-config: wrote ${outFile} (${REQUIRED_ENV.length} values from env)`);
}
