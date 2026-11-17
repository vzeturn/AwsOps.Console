/**
 * `sessionRecovery.ts` — the single place that decides what to do when the Entra ID session goes
 * bad, from EITHER of the two ways that can happen:
 *
 *   1. `oidc-client-ts`'s own `automaticSilentRenew` tries to refresh the token in the background
 *      and fails (see `useUnauthorizedRecovery.ts`, which listens for this via
 *      `auth.events.addSilentRenewError`).
 *   2. The router rejects an already-in-flight request with `401 Unauthorized` because the token
 *      it received had already expired by the time the request landed (see `queryClient.ts`'s
 *      `onError`, which reads `ApiError.status`).
 *
 * WHY A SEPARATE MODULE, NOT INLINE IN A HOOK
 *
 * Both trigger points above are OUTSIDE React's render cycle (a QueryClient callback, an
 * event-emitter callback) — neither can call `useAuth()` itself. `useUnauthorizedRecovery.ts`
 * (a hook, rendered once in `__root.tsx`) is the only place with legitimate access to the live
 * `AuthContextProps` object, so it registers that object here via `registerAuth()`, and this
 * module hands it back out to whichever non-React callback needs it. This mirrors the same
 * "hook writes into a plain module ref, non-React code reads it" pattern already used for
 * Cloudscape's `applyMode`/`applyDensity` in `uiStore.ts`, just for an object instead of a value.
 *
 * WHY TRY SILENT RENEWAL BEFORE FORCING A FULL SIGN-OUT
 *
 * The most common real-world cause of "the token expired" is NOT that the user's session is
 * genuinely over — it's that `automaticSilentRenew`'s background refresh missed its window (the
 * laptop was asleep, the tab was backgrounded and throttled by the browser, a single network blip
 * landed on the one attempt `oidc-client-ts` made). In that case a fresh `signinSilent()` call
 * (using the refresh token already sitting in `offline_access`, see `oidcConfig.ts`) succeeds
 * INSTANTLY with no visible interruption — the user never even notices. Only when Entra ID itself
 * refuses silent renewal (the refresh token was revoked, a Conditional Access policy requires
 * re-authentication, the session genuinely expired past the refresh token's own lifetime) does
 * this fall back to `removeUser()` + `signinRedirect()` — a REAL sign-out followed by a REAL
 * sign-in, exactly what the user would otherwise have to do by hand via the "Sign out" menu.
 *
 * DEDUPLICATION
 *
 * A single expired-token moment can trigger `recoverFromUnauthorized()` several times at once —
 * e.g. 3 `useQuery` calls all failing with 401 in the same tick, or a `SilentRenewError` firing
 * while a request is already mid-flight. Without de-duplication each caller would independently
 * kick off its own `signinSilent()`/`signinRedirect()`, which is at best wasted work and at worst
 * a redirect race. `inFlightRecovery` ensures every caller within the same recovery attempt shares
 * ONE promise and ONE outcome.
 */

/**
 * The minimal slice of `AuthContextProps` (from `react-oidc-context`) this module actually calls
 * — kept narrow (not the full interface) so a test can register a plain object without pulling in
 * the real OIDC machinery, and so this module's contract stays obvious at a glance.
 */
export interface RecoverableAuth {
  signinSilent(): Promise<unknown>;
  removeUser(): Promise<void>;
  signinRedirect(): Promise<void>;
}

let authRef: RecoverableAuth | undefined;

/** Called once by `useUnauthorizedRecovery()` on every render, so `authRef` always points at the
 * CURRENT auth instance (react-oidc-context does not guarantee the same object identity across
 * re-renders after a `signinSilent()`/`signinRedirect()` cycle). */
export function registerAuth(auth: RecoverableAuth): void {
  authRef = auth;
}

/** Test-only reset — production code never needs to un-register, since the app has exactly one
 * `AuthProvider` for its whole lifetime. */
export function __resetSessionRecoveryForTests(): void {
  authRef = undefined;
  inFlightRecovery = undefined;
}

let inFlightRecovery: Promise<'renewed' | 'redirecting'> | undefined;

/**
 * Attempts to recover from an expired/invalid session: `signinSilent()` first, falling back to a
 * full `removeUser()` + `signinRedirect()` if silent renewal fails for any reason (including
 * `signinSilent()` resolving to `null`, which `oidc-client-ts` uses for "no error, but no user
 * either" — treated the same as a thrown error, since either way there is no usable token).
 *
 * Returns `'renewed'` when silent renewal succeeded (the caller can safely retry/invalidate
 * queries immediately — a fresh token is already in place) or `'redirecting'` when the browser is
 * about to navigate away to the Entra ID sign-in page (nothing left for the caller to do; the
 * current page is going away). Never rejects — a `signinRedirect()` failure has nothing more
 * useful this module can do than log it, since there is no further fallback below "ask the user
 * to sign in".
 */
export function recoverFromUnauthorized(): Promise<'renewed' | 'redirecting'> {
  if (inFlightRecovery) return inFlightRecovery;
  if (!authRef) {
    // No `AuthProvider` has registered yet (e.g. this fires before the first render, or in a test
    // that never calls `registerAuth`) — nothing this module can do; the ordinary "not
    // authenticated" screen (`__root.tsx`'s `SignInGate`) is the correct fallback UI in that case.
    return Promise.resolve('redirecting');
  }

  const auth = authRef;
  inFlightRecovery = (async () => {
    try {
      const user = await auth.signinSilent();
      if (user) return 'renewed' as const;
      throw new Error('signinSilent() returned no user');
    } catch {
      // `removeUser()` failing (e.g. a storage error clearing the cached user) must NOT stop the
      // redirect from happening — an un-cleared local user object is a smaller problem than
      // leaving the user stuck on a broken page with no path back to signing in. Swallow it
      // explicitly rather than relying on `finally` (which propagates the original rejection
      // once the block exits, it does not suppress it).
      await auth.removeUser().catch(() => undefined);
      await auth.signinRedirect();
      return 'redirecting' as const;
    }
  })().finally(() => {
    inFlightRecovery = undefined;
  });

  return inFlightRecovery;
}
