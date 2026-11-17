import { describe, it, expect, vi, beforeEach } from 'vitest';
import { recoverFromUnauthorized, registerAuth, __resetSessionRecoveryForTests, type RecoverableAuth } from './sessionRecovery';

function makeAuth(overrides: Partial<RecoverableAuth> = {}): RecoverableAuth {
  return {
    signinSilent: vi.fn().mockResolvedValue({}),
    removeUser: vi.fn().mockResolvedValue(undefined),
    signinRedirect: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

beforeEach(() => {
  __resetSessionRecoveryForTests();
});

describe('recoverFromUnauthorized', () => {
  it('no auth registered yet -> resolves "redirecting" without throwing (fail-safe)', async () => {
    await expect(recoverFromUnauthorized()).resolves.toBe('redirecting');
  });

  it('signinSilent() succeeds (returns a user) -> resolves "renewed", never calls removeUser/signinRedirect', async () => {
    const auth = makeAuth();
    registerAuth(auth);

    const outcome = await recoverFromUnauthorized();

    expect(outcome).toBe('renewed');
    expect(auth.signinSilent).toHaveBeenCalledTimes(1);
    expect(auth.removeUser).not.toHaveBeenCalled();
    expect(auth.signinRedirect).not.toHaveBeenCalled();
  });

  it('signinSilent() resolves null (no error, no user) -> falls back to removeUser + signinRedirect, resolves "redirecting"', async () => {
    const auth = makeAuth({ signinSilent: vi.fn().mockResolvedValue(null) });
    registerAuth(auth);

    const outcome = await recoverFromUnauthorized();

    expect(outcome).toBe('redirecting');
    expect(auth.removeUser).toHaveBeenCalledTimes(1);
    expect(auth.signinRedirect).toHaveBeenCalledTimes(1);
  });

  it('signinSilent() rejects (Entra ID refuses renewal, e.g. Conditional Access) -> falls back to a real sign-out + sign-in', async () => {
    const auth = makeAuth({ signinSilent: vi.fn().mockRejectedValue(new Error('login_required')) });
    registerAuth(auth);

    const outcome = await recoverFromUnauthorized();

    expect(outcome).toBe('redirecting');
    expect(auth.removeUser).toHaveBeenCalledTimes(1);
    expect(auth.signinRedirect).toHaveBeenCalledTimes(1);
  });

  it('removeUser() itself throws -> still attempts signinRedirect (never leaves the user stranded)', async () => {
    const auth = makeAuth({
      signinSilent: vi.fn().mockRejectedValue(new Error('login_required')),
      removeUser: vi.fn().mockRejectedValue(new Error('storage error')),
    });
    registerAuth(auth);

    const outcome = await recoverFromUnauthorized();

    expect(outcome).toBe('redirecting');
    expect(auth.signinRedirect).toHaveBeenCalledTimes(1);
  });

  it('concurrent callers during the SAME recovery attempt share one signinSilent() call, not one each', async () => {
    let resolveSilent!: (value: unknown) => void;
    const auth = makeAuth({
      signinSilent: vi.fn().mockImplementation(() => new Promise((resolve) => (resolveSilent = resolve))),
    });
    registerAuth(auth);

    const first = recoverFromUnauthorized();
    const second = recoverFromUnauthorized();
    const third = recoverFromUnauthorized();

    resolveSilent({});
    const results = await Promise.all([first, second, third]);

    expect(auth.signinSilent).toHaveBeenCalledTimes(1);
    expect(results).toEqual(['renewed', 'renewed', 'renewed']);
  });

  it('a SUBSEQUENT call after a completed recovery starts a fresh attempt (not stuck sharing the old promise)', async () => {
    const auth = makeAuth();
    registerAuth(auth);

    await recoverFromUnauthorized();
    await recoverFromUnauthorized();

    expect(auth.signinSilent).toHaveBeenCalledTimes(2);
  });

  it('re-registering a different auth instance mid-session makes subsequent recovery use the NEW instance', async () => {
    const firstAuth = makeAuth();
    registerAuth(firstAuth);
    await recoverFromUnauthorized();

    const secondAuth = makeAuth();
    registerAuth(secondAuth);
    await recoverFromUnauthorized();

    expect(firstAuth.signinSilent).toHaveBeenCalledTimes(1);
    expect(secondAuth.signinSilent).toHaveBeenCalledTimes(1);
  });
});
