import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const registerAuthMock = vi.fn();
const recoverFromUnauthorizedMock = vi.fn();
vi.mock('../lib/sessionRecovery', () => ({
  registerAuth: (...args: unknown[]) => registerAuthMock(...args),
  recoverFromUnauthorized: (...args: unknown[]) => recoverFromUnauthorizedMock(...args),
}));

let silentRenewErrorCallback: (() => void) | undefined;
const unsubscribeMock = vi.fn();
const addSilentRenewErrorMock = vi.fn((cb: () => void) => {
  silentRenewErrorCallback = cb;
  return unsubscribeMock;
});

function makeAuth() {
  return {
    signinSilent: vi.fn(),
    removeUser: vi.fn(),
    signinRedirect: vi.fn(),
    events: { addSilentRenewError: addSilentRenewErrorMock },
  };
}

let currentAuth = makeAuth();
vi.mock('react-oidc-context', () => ({
  useAuth: () => currentAuth,
}));

const { useUnauthorizedRecovery } = await import('./useUnauthorizedRecovery');

beforeEach(() => {
  registerAuthMock.mockReset();
  recoverFromUnauthorizedMock.mockReset();
  addSilentRenewErrorMock.mockClear();
  unsubscribeMock.mockReset();
  silentRenewErrorCallback = undefined;
  currentAuth = makeAuth();
});

describe('useUnauthorizedRecovery', () => {
  it('registers the current auth instance on render', () => {
    renderHook(() => useUnauthorizedRecovery());
    expect(registerAuthMock).toHaveBeenCalledWith(currentAuth);
  });

  it('subscribes to addSilentRenewError on mount', () => {
    renderHook(() => useUnauthorizedRecovery());
    expect(addSilentRenewErrorMock).toHaveBeenCalledTimes(1);
  });

  it('a silent-renew error triggers recoverFromUnauthorized()', () => {
    renderHook(() => useUnauthorizedRecovery());
    expect(silentRenewErrorCallback).toBeDefined();

    silentRenewErrorCallback!();

    expect(recoverFromUnauthorizedMock).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes on unmount', () => {
    const { unmount } = renderHook(() => useUnauthorizedRecovery());
    unmount();
    expect(unsubscribeMock).toHaveBeenCalledTimes(1);
  });
});
