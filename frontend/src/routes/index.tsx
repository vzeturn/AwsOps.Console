import { createFileRoute, redirect } from '@tanstack/react-router';
import { hasAuthParams } from 'react-oidc-context';

/** Infra Map is the landing tab — the first question opening an ops console answers is "is
 * anything wrong", and a topology picture answers that faster than any table.
 *
 * Guard: skip the redirect while an Entra ID signin callback is pending (`?code=&state=` or
 * `?error=&state=` still in the URL). `AuthProvider`'s own mount effect (see
 * `auth/oidcConfig.ts`) reads those query params straight off `window.location` to exchange the
 * code for tokens — `hasAuthParams()` here is the exact same check react-oidc-context uses
 * internally. Without this guard, this route's `beforeLoad` fires first (it runs at the router
 * level, independent of and before `AuthProvider`'s effect), redirects to `/infra-map`, and that
 * redirect rewrites the URL — permanently stripping `?code=&state=` before `AuthProvider` ever
 * gets to see them. The signin then silently never completes: no error, just back on the sign-in
 * screen. Once `onSigninCallback` strips the query string itself after a REAL successful token
 * exchange, this route re-evaluates (the URL change re-triggers routing) and redirects normally.
 */
export const Route = createFileRoute('/')({
  beforeLoad: () => {
    if (hasAuthParams()) return;
    throw redirect({ to: '/infra-map' });
  },
});
