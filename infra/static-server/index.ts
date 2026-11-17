import { existsSync, readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from 'aws-lambda';
import { securityHeaders } from '../../backend/src/shared-kernel/securityHeaders.js';

/**
 * Lambda "static-server": exposes frontend/dist directly through this Lambda's own
 * Function URL — the same "$0 forever" architecture as ec2-state-manager (see
 * infra/ec2-state-manager/static-server/index.ts). frontend/dist is copied into the
 * `site/` folder next to this bundle file at build time (see infra/scripts/copy-frontend.cjs).
 */
const SITE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'site');

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

const TEXT_EXTENSIONS = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.map', '.txt']);
const NO_CACHE = 'no-cache, no-store, must-revalidate';

function contentTypeFor(filePath: string): string {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

function cacheControlFor(relPath: string): string {
  return relPath.startsWith('assets/') ? 'public, max-age=31536000, immutable' : NO_CACHE;
}

/** window.__APP_CONFIG__ generated dynamically from the Lambda env. */
function configJs(): string {
  const tenantId = process.env.ENTRA_TENANT_ID ?? '';
  const clientId = process.env.ENTRA_CLIENT_ID ?? '';
  const body = {
    entraAuthority: `https://login.microsoftonline.com/${tenantId}/v2.0`,
    entraClientId: clientId,
    apiBaseUrl: process.env.API_BASE_URL ?? '',
    redirectUri: process.env.SITE_URL ?? '',
    // `offline_access` IS REQUIRED, not optional.
    //
    // Previously the scope was just 'openid profile email', so Entra ID did NOT issue a
    // refresh token. Without one, `automaticSilentRenew: true` in oidc-client-ts (see
    // frontend/src/auth/oidcConfig.ts) has no refresh token to use and has to fall back
    // to the hidden-iframe renewal mechanism pointed at login.microsoftonline.com. Modern
    // browsers block third-party cookies inside that iframe => renewal fails SILENTLY.
    //
    // Observed consequence: after ~60-90 minutes the token expires, `auth.user.id_token`
    // keeps returning the same stale expired token, the backend's `jwtVerify` rejects it
    // => every tab shows "Failed to load data: Unauthorized", and because the dashboard
    // polls every 45-60 seconds the error keeps reappearing until the user manually
    // reloads the page.
    //
    // With `offline_access`, oidc-client-ts renews through the token endpoint (a direct
    // HTTP POST) instead of the iframe, so it no longer depends on third-party cookies.
    //
    // Do NOT add `api://<clientId>/access_as_user` here.
    //
    // This was tried (commit 1543fe9) and had to be REVERTED. Combining the API scope into
    // the same `openid profile email offline_access` request asks for tokens for TWO
    // different resources in a single call. The Microsoft identity platform only issues an
    // access token for ONE resource; it picks Microsoft Graph and silently drops our API
    // scope. The token the browser actually received:
    //     aud = 00000003-0000-0000-c000-000000000000   (Microsoft Graph)
    //     iss = https://sts.windows.net/<tenantId>/     (v1 format)
    //     scp = email openid profile                    (no access_as_user)
    // => the backend rejects it with ERR_JWS_SIGNATURE_VERIFICATION_FAILED, and every tab
    //    keeps showing "Invalid or expired token".
    //
    // The app registration STILL keeps the full configuration (see
    // infra/entra-expose-api.json), and an access token requested separately for that
    // resource has been verified to work correctly (iss .../v2.0, aud <clientId>, scp
    // access_as_user). The problem is in HOW it's requested, not in the configuration.
    // To use the access token, it must be obtained via a SEPARATE request that contains
    // only the API scope.
    scope: 'openid profile email offline_access',
  };
  return `window.__APP_CONFIG__ = ${JSON.stringify(body)};`;
}

/** Minimum size (bytes) to enable gzip — a very small file (e.g. a few lines of SVG) can end up
 * LARGER than the original after compression due to gzip header overhead; not worth the CPU
 * round-trip to compress it. */
const GZIP_MIN_BYTES = 1024;

/** Lambda Function URL already normalizes header names to lowercase (like API Gateway HTTP API
 * v2), but we still read case-insensitively to be safe (same pattern as
 * `readHeaderCaseInsensitive` in `backend/src/modules/web/auth.ts` — not relying on undocumented implicit
 * AWS behavior). */
function acceptsGzip(event: LambdaFunctionURLEvent): boolean {
  const headers = event.headers as Record<string, string | undefined> | undefined;
  if (!headers) return false;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === 'accept-encoding');
  const value = key ? headers[key] : undefined;
  return (value ?? '').includes('gzip');
}

/** The router's origin — the ONLY external origin the SPA's `fetch()` calls target (see
 * `frontend/src/api/client.ts`'s `appConfig.apiBaseUrl`, derived from this same `API_BASE_URL`
 * env var, see `configJs()` below). Needed in the page's own CSP `connect-src` because the SPA is
 * served FROM this Lambda's origin but calls a DIFFERENT Function URL for the API. */
function routerOrigin(): string[] {
  const apiBaseUrl = process.env.API_BASE_URL;
  if (!apiBaseUrl) return [];
  try {
    return [new URL(apiBaseUrl).origin];
  } catch {
    return [];
  }
}

function response(
  statusCode: number,
  body: string,
  contentType: string,
  cacheControl: string,
  isBase64Encoded = false,
  contentEncoding?: 'gzip',
): LambdaFunctionURLResult {
  const headers: Record<string, string> = {
    'content-type': contentType,
    'cache-control': cacheControl,
    ...securityHeaders({ connectSrcOrigins: routerOrigin() }),
  };
  if (contentEncoding) headers['content-encoding'] = contentEncoding;
  return { statusCode, headers, body, isBase64Encoded };
}

/**
 * Compresses `buffer` with gzip and returns base64 (Lambda Function URL — like API Gateway —
 * only supports binary bodies via `isBase64Encoded: true`, and does NOT support returning a raw
 * `Buffer`) when the client signals gzip support (`Accept-Encoding`) AND the content is large
 * enough for compression to be worthwhile (`GZIP_MIN_BYTES`). Applied to EVERY text response
 * (`index.html`/`config.js`/JS/CSS/JSON/SVG) — previously there was no compression at all, so the
 * ~743KB JS bundle (per the build log) was transferred over the network in full plaintext on
 * every page load (the dashboard "loading slowly" — the gzip-equivalent size is only ~220KB per
 * the Vite build output).
 */
function textResponse(
  statusCode: number,
  text: string,
  contentType: string,
  cacheControl: string,
  event: LambdaFunctionURLEvent,
): LambdaFunctionURLResult {
  const raw = Buffer.from(text, 'utf8');
  if (raw.byteLength >= GZIP_MIN_BYTES && acceptsGzip(event)) {
    const gzipped = gzipSync(raw);
    return response(statusCode, gzipped.toString('base64'), contentType, cacheControl, true, 'gzip');
  }
  return response(statusCode, text, contentType, cacheControl);
}

function readIndexFallback(event: LambdaFunctionURLEvent): LambdaFunctionURLResult {
  const indexPath = path.join(SITE_DIR, 'index.html');
  if (!existsSync(indexPath)) {
    return response(500, 'frontend/dist has not been built — run `npm run build --workspace frontend` then redeploy.', 'text/plain; charset=utf-8', NO_CACHE);
  }
  return textResponse(200, readFileSync(indexPath, 'utf8'), 'text/html; charset=utf-8', NO_CACHE, event);
}

export async function handler(event: LambdaFunctionURLEvent): Promise<LambdaFunctionURLResult> {
  const rawPath = decodeURIComponent(event.rawPath || '/');
  const relPath = rawPath.replace(/^\/+/, '');

  if (relPath === 'config.js') {
    return textResponse(200, configJs(), 'application/javascript; charset=utf-8', NO_CACHE, event);
  }

  const candidate = relPath === '' ? 'index.html' : relPath;
  const filePath = path.join(SITE_DIR, candidate);

  const isWithinSite = filePath === SITE_DIR || filePath.startsWith(SITE_DIR + path.sep);
  const isFile = isWithinSite && existsSync(filePath) && statSync(filePath).isFile();
  if (!isFile) {
    return readIndexFallback(event);
  }

  const isText = TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
  const buffer = readFileSync(filePath);
  if (isText) {
    return textResponse(200, buffer.toString('utf8'), contentTypeFor(filePath), cacheControlFor(candidate), event);
  }
  // Binary (images/fonts) — do NOT gzip further: these formats (woff2/png/jpeg...) are already
  // compressed at the format level, so gzipping again only costs CPU without meaningfully
  // reducing size further.
  return response(200, buffer.toString('base64'), contentTypeFor(filePath), cacheControlFor(candidate), true);
}
