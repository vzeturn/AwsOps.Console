import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient } from '@tanstack/react-query';

// `queryClient.ts` imports `../api/client`, which reads `window.__APP_CONFIG__` at MODULE SCOPE
// (see `config.ts`) — must be set before that import chain runs, same convention already used in
// `useActionDialog.test.tsx`.
window.__APP_CONFIG__ = {
  entraAuthority: 'https://login.microsoftonline.com/tenant/v2.0',
  entraClientId: 'client-id',
  apiBaseUrl: 'https://router.example.com',
  redirectUri: 'https://app.example.com',
  scope: 'openid profile email offline_access',
};

const { ApiError } = await import('../api/client');

const recoverFromUnauthorizedMock = vi.fn();
vi.mock('./sessionRecovery', () => ({
  recoverFromUnauthorized: (...args: unknown[]) => recoverFromUnauthorizedMock(...args),
}));

// Imported AFTER the mock is declared (vi.mock is hoisted by vitest) so `queryClient.ts` picks up
// the mocked `recoverFromUnauthorized` instead of the real one.
const { queryClient } = await import('./queryClient');

beforeEach(() => {
  recoverFromUnauthorizedMock.mockReset();
  queryClient.clear();
});

describe('queryClient — 401 recovery wiring', () => {
  it('a query failing with ApiError(401) triggers recoverFromUnauthorized()', async () => {
    recoverFromUnauthorizedMock.mockResolvedValue('renewed');

    await queryClient.fetchQuery({
      queryKey: ['test-401-query'],
      queryFn: () => Promise.reject(new ApiError(401, 'Invalid or expired token')),
      retry: false,
    }).catch(() => undefined);

    expect(recoverFromUnauthorizedMock).toHaveBeenCalledTimes(1);
  });

  it('recovery resolves "renewed" -> invalidates queries so the next render gets a fresh fetch', async () => {
    recoverFromUnauthorizedMock.mockResolvedValue('renewed');
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    await queryClient.fetchQuery({
      queryKey: ['test-401-renewed'],
      queryFn: () => Promise.reject(new ApiError(401, 'Invalid or expired token')),
      retry: false,
    }).catch(() => undefined);

    // recoverFromUnauthorized's .then() callback runs on a later microtask.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(invalidateSpy).toHaveBeenCalledTimes(1);
  });

  it('recovery resolves "redirecting" -> does NOT invalidate queries (the page is navigating away)', async () => {
    recoverFromUnauthorizedMock.mockResolvedValue('redirecting');
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    await queryClient.fetchQuery({
      queryKey: ['test-401-redirecting'],
      queryFn: () => Promise.reject(new ApiError(401, 'Invalid or expired token')),
      retry: false,
    }).catch(() => undefined);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it('a non-401 ApiError does NOT trigger recovery', async () => {
    await queryClient.fetchQuery({
      queryKey: ['test-403-query'],
      queryFn: () => Promise.reject(new ApiError(403, 'Forbidden')),
      retry: false,
    }).catch(() => undefined);

    expect(recoverFromUnauthorizedMock).not.toHaveBeenCalled();
  });

  it('a plain Error (not ApiError) does NOT trigger recovery', async () => {
    await queryClient.fetchQuery({
      queryKey: ['test-plain-error'],
      queryFn: () => Promise.reject(new Error('network down')),
      retry: false,
    }).catch(() => undefined);

    expect(recoverFromUnauthorizedMock).not.toHaveBeenCalled();
  });

  it('a mutation failing with ApiError(401) also triggers recovery', async () => {
    recoverFromUnauthorizedMock.mockResolvedValue('renewed');
    const localClient = queryClient; // same instance, mutations share the same MutationCache
    const mutation = localClient.getMutationCache().build(localClient, {
      mutationFn: () => Promise.reject(new ApiError(401, 'Invalid or expired token')),
    });

    await mutation.execute({}).catch(() => undefined);

    expect(recoverFromUnauthorizedMock).toHaveBeenCalledTimes(1);
  });
});

describe('queryClient — sanity (unrelated to recovery)', () => {
  it('is a real QueryClient instance', () => {
    expect(queryClient).toBeInstanceOf(QueryClient);
  });
});
