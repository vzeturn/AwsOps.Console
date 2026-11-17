import type { AuthProviderProps } from 'react-oidc-context';
import { WebStorageStateStore } from 'oidc-client-ts';
import { appConfig } from '../config';

/**
 * `scope` comes from `config.js`, generated at runtime by `infra/static-server/index.ts`, and
 * MUST include `offline_access` — without it Entra ID issues no refresh token, and
 * `automaticSilentRenew` falls back to a hidden iframe that modern browsers block (third-party
 * cookies), so silent renewal fails without any visible error until the token actually expires.
 * See the long comment in `infra/static-server/index.ts::configJs()` for the full incident
 * history — do NOT add `api://<clientId>/access_as_user` to this scope, for the same reason.
 */
export const oidcConfig: AuthProviderProps = {
  authority: appConfig.entraAuthority,
  client_id: appConfig.entraClientId,
  redirect_uri: appConfig.redirectUri,
  post_logout_redirect_uri: appConfig.redirectUri,
  response_type: 'code',
  scope: appConfig.scope,
  userStore: new WebStorageStateStore({ store: window.localStorage }),
  automaticSilentRenew: true,
  // Start renewing 5 minutes before expiry rather than oidc-client-ts's 60-second default — a
  // single failed renewal attempt (network blip, cold start, laptop waking from sleep) is enough
  // to let the token actually expire at 60 seconds; 5 minutes gives several retries of headroom.
  accessTokenExpiringNotificationTimeInSeconds: 300,
  onSigninCallback: () => {
    window.history.replaceState({}, document.title, window.location.pathname);
  },
};
