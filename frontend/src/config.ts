/**
 * Reads `window.__APP_CONFIG__`, synthesized at runtime by `infra/static-server/index.ts`
 * (Lambda deployment) — see that file's `configJs()` for exactly which fields it sets and why
 * `offline_access` must stay in `scope`. Kept as a thin reader here (not duplicated logic) so
 * both deployment targets (the Lambda and any future static host) only need to agree on this one
 * shape.
 */
export interface AppConfig {
  entraAuthority: string;
  entraClientId: string;
  apiBaseUrl: string;
  redirectUri: string;
  scope: string;
}

declare global {
  interface Window {
    __APP_CONFIG__?: AppConfig;
  }
}

function readConfig(): AppConfig {
  const cfg = window.__APP_CONFIG__;
  if (!cfg) {
    throw new Error('window.__APP_CONFIG__ is missing — config.js did not load before main.tsx, or static-server is misconfigured.');
  }
  return cfg;
}

export const appConfig: AppConfig = readConfig();
