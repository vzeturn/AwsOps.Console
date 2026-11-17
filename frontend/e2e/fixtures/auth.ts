import type { Page } from '@playwright/test';

/**
 * Injects a fake, already-authenticated OIDC user into `localStorage` BEFORE the SPA's first
 * script runs, in the exact shape `oidc-client-ts`'s `UserManager` expects to find one on startup
 * (`WebStorageStateStore` backed by `window.localStorage`, see `src/auth/oidcConfig.ts`).
 *
 * Storage key format confirmed from `node_modules/oidc-client-ts/dist/esm/oidc-client-ts.js`:
 *   `user:${settings.authority}:${settings.client_id}`, then prefixed with `"oidc."` by
 *   `WebStorageStateStore`'s default `prefix` option (`src/auth/oidcConfig.ts` doesn't override
 *   it) — the actual `localStorage` key is `oidc.user:${authority}:${client_id}`.
 * Stored value shape confirmed from the same file's `User.toStorageString()`:
 *   `{ id_token, session_state, access_token, refresh_token, token_type, scope, profile, expires_at }`
 *
 * `expires_at` is a Unix seconds timestamp; `react-oidc-context`'s reducer sets
 * `isAuthenticated = !user.expired`, and `User.expired` is `(expires_at - nowSeconds) <= 0` — so an
 * `expires_at` far in the future is required for the app to treat this as a live, non-expired session.
 *
 * This deliberately bypasses the real Entra ID redirect flow entirely (no network call, no popup) —
 * the E2E suite tests the SPA's own behavior against a mocked backend, not Entra ID's login UI.
 */
export interface MockUserOptions {
  name?: string;
  email?: string;
  sub?: string;
  isOperator?: boolean;
  operatorStatusUnknown?: boolean;
}

/** Matches `public/config.js` (the config the local preview server serves in this test environment) — see the comment there for why the exact authority/client_id values are otherwise unused. */
const ENTRA_AUTHORITY = 'https://login.microsoftonline.com/00000000-0000-0000-0000-000000000000/v2.0';
const ENTRA_CLIENT_ID = '00000000-0000-0000-0000-000000000000';

/** A fixed, non-secret, structurally-plausible JWT (header.payload.signature, base64url) — never
 * verified by anything in this test run (the mocked backend in `mockApi.ts` never checks it), it
 * only needs to be a non-empty string so `api/client.ts`'s `authorization: Bearer ${token}` header
 * is well-formed. Stored as `id_token` (not `access_token`) because `useApi.ts::useToken()` reads
 * `id_token` — see that file's doc comment for why the access token can't be used with this app's
 * OIDC scope config. */
const FAKE_ID_TOKEN =
  'eyJhbGciOiJub25lIn0.eyJzdWIiOiJlMmUtdGVzdC11c2VyIn0.e2e-test-signature-not-real';

export async function mockSignedInUser(page: Page, options: MockUserOptions = {}): Promise<void> {
  const {
    name = 'E2E Test User',
    email = 'e2e-test-user@example.test',
    sub = 'e2e-test-sub-0001',
  } = options;

  const storageKey = `oidc.user:${ENTRA_AUTHORITY}:${ENTRA_CLIENT_ID}`;
  const stored = {
    id_token: FAKE_ID_TOKEN,
    session_state: null,
    access_token: null,
    refresh_token: undefined,
    token_type: 'Bearer',
    scope: 'openid profile email offline_access',
    profile: { sub, name, email },
    // 1 hour in the future — comfortably outside accessTokenExpiringNotificationTimeInSeconds (300s)
    // so no silent-renew attempt kicks in mid-test.
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  };

  await page.addInitScript(
    ({ key, value }) => {
      window.localStorage.setItem(key, value);
    },
    { key: storageKey, value: JSON.stringify(stored) },
  );
}
