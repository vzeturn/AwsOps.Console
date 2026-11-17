import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import { ApiError } from '../api/client';
import { recoverFromUnauthorized } from './sessionRecovery';

/**
 * Router's OWN token could still expire AFTER the frontend already sent a request with it — the
 * background `automaticSilentRenew` (see `oidcConfig.ts`) renews 5 minutes before the token's own
 * `exp`, but a request already in flight at that exact moment (a slow network, a Lambda cold
 * start) can still land after `exp` and get rejected with `401` by `backend/src/lib/auth.ts`'s
 * `verifyEntraToken`. `useUnauthorizedRecovery.ts` covers the OTHER trigger (Entra ID's own
 * silent-renew failing in the background, before any request is even sent) — this `onError` hook
 * is the one that reacts to the SAME underlying problem surfacing through an actual API call
 * instead, so either path leads to the same recovery, not two different half-fixes.
 *
 * `invalidateQueries()` is only called once recovery reports `'renewed'` — refetching with the
 * SAME stale token that just failed would just reproduce the same 401 for nothing; only a fresh
 * token makes a retry worth doing. When recovery instead falls back to a full sign-out +
 * redirect (`'redirecting'`), the current page is about to navigate away, so there is nothing
 * left worth invalidating.
 */
function handlePossibleUnauthorizedError(error: unknown, queryClient: QueryClient): void {
  if (!(error instanceof ApiError) || error.status !== 401) return;
  void recoverFromUnauthorized().then((outcome) => {
    if (outcome === 'renewed') void queryClient.invalidateQueries();
  });
}

/**
 * One shared QueryClient for the whole app. Defaults chosen to match the backend's own caching
 * cadence (see README.md's collector-cadence table): the fastest-changing data (`/monitoring`) is
 * still bounded by a 4-minute server-side TTL, so refetching more aggressively than that from the
 * client would only add load without fresher data.
 */
export const queryClient: QueryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error) => handlePossibleUnauthorizedError(error, queryClient),
  }),
  mutationCache: new MutationCache({
    onError: (error) => handlePossibleUnauthorizedError(error, queryClient),
  }),
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: true,
    },
  },
});
