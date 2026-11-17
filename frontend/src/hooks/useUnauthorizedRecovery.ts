import { useEffect } from 'react';
import { useAuth } from 'react-oidc-context';
import { recoverFromUnauthorized, registerAuth } from '../lib/sessionRecovery';

/**
 * `useUnauthorizedRecovery()` — call ONCE, near the top of the component tree that already calls
 * `useAuth()` (see `__root.tsx`'s `RootLayout`, which renders unconditionally once `AuthProvider`
 * has finished loading). Two jobs:
 *
 *   1. Keeps `sessionRecovery.ts`'s module-level `authRef` pointed at the CURRENT auth instance,
 *      so code outside React (the QueryClient's `onError`, see `queryClient.ts`) can trigger
 *      recovery without needing its own `useAuth()` call.
 *   2. Subscribes to `auth.events.addSilentRenewError` — `oidc-client-ts`'s own signal that
 *      `automaticSilentRenew` (configured in `oidcConfig.ts`) tried to refresh the token in the
 *      background and failed. Requirement: with SSO, a token problem should lead to a sign-out
 *      and a fresh sign-in — today, a silent-renew failure is caught by
 *      `AuthProvider`/`useAuth().error` (see `oidcConfig.ts`'s file header on why `offline_access`
 *      matters here) but nothing acts on it: the token simply goes stale and every subsequent API
 *      call starts failing with 401 until a human notices and manually signs out. This hook is
 *      what turns "notices and manually signs out" into "recovers automatically, before the user
 *      sees anything break".
 */
export function useUnauthorizedRecovery(): void {
  const auth = useAuth();

  // Re-registered on every render (not just once) — see `registerAuth`'s doc comment on why
  // object identity is not guaranteed stable across a `signinSilent()`/`signinRedirect()` cycle.
  registerAuth(auth);

  useEffect(() => {
    // `addSilentRenewError` returns an unsubscribe function — the same convention every
    // `oidc-client-ts` event uses, mirrored here as the effect's own cleanup.
    return auth.events.addSilentRenewError(() => {
      void recoverFromUnauthorized();
    });
    // `auth.events` is a stable `UserManagerEvents` instance owned by the single `UserManager`
    // `AuthProvider` creates for the app's lifetime — safe to depend on directly, and doing so
    // (rather than depending on `auth` as a whole) avoids tearing down and resubscribing this
    // listener on every token refresh.
  }, [auth.events]);
}
