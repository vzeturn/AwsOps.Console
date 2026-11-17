// Local development / E2E test fallback for `window.__APP_CONFIG__` (see `src/config.ts`).
//
// This file is NOT used in production: `infra/deploy-frontend-cloudflare.sh` runs
// `frontend/scripts/generate-config.mjs` AFTER `vite build`, which overwrites `dist/config.js`
// with real values read from the live CloudFormation stack. Vite copies everything under
// `public/` into `dist/` verbatim during build, which is why this file exists at all — without
// it, `vite preview`/`vite dev` would 404 on `/config.js` and `main.tsx` would never run (see
// `config.ts`'s `readConfig()`).
//
// The values below are placeholders: `entraAuthority`/`entraClientId` are never actually used by
// the Playwright E2E suite (auth is injected directly into localStorage, see
// `e2e/fixtures/auth.ts`, bypassing the real Entra ID redirect flow entirely) — `apiBaseUrl` is
// the only value that matters, and every request to it is intercepted by
// `e2e/fixtures/mockApi.ts` before it would ever hit the network.
window.__APP_CONFIG__ = {
  entraAuthority: 'https://login.microsoftonline.com/00000000-0000-0000-0000-000000000000/v2.0',
  entraClientId: '00000000-0000-0000-0000-000000000000',
  apiBaseUrl: 'https://api.e2e.test',
  redirectUri: 'http://127.0.0.1:4173',
  scope: 'openid profile email offline_access',
};
