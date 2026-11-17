import { describe, it, expect, vi } from 'vitest';

window.__APP_CONFIG__ = {
  entraAuthority: 'https://login.microsoftonline.com/tenant/v2.0',
  entraClientId: 'client-id',
  apiBaseUrl: 'https://router.example.com',
  redirectUri: 'https://app.example.com',
  scope: 'openid profile email offline_access',
};

// `createFileRoute` needs a real router context this unit test does not want to stand up — this
// file never renders `InfraMapPage` itself (which is deliberately NOT exported, to keep
// `/infra-map`'s dedicated bundle chunk intact — see that file's own comment for the full story
// including what was actually tried and why it broke Requirement 3.5's bundle isolation). Instead
// this tests the two independently-exported, DOM-free/render-free pieces of its Interactive_Kpi
// wiring (Requirement 1) directly: `scrollAndHighlight` and `resolveUnplacedKpiActivation`. The
// interactive AFFORDANCE itself (role="button"/tabIndex/keyboard activation/dev-mode warning) is
// `KpiTile.test.tsx`'s job, already covered there against the real component in isolation — this
// file only needs `createFileRoute` mocked so importing the module at all does not throw outside
// a router context, it never touches anything from `@tanstack/react-router` beyond that.
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>();
  return { ...actual, createFileRoute: () => () => ({ useParams: () => ({}) }) };
});

const { scrollAndHighlight, resolveUnplacedKpiActivation } = await import('./infra-map');

describe('resolveUnplacedKpiActivation (Requirement 1.1/1.3)', () => {
  it('returns no onActivate/activateLabel when there are 0 unplaced resources (nothing to drill into)', () => {
    expect(resolveUnplacedKpiActivation(0)).toEqual({});
  });

  it('returns a real onActivate + activateLabel when there is at least 1 unplaced resource', () => {
    const result = resolveUnplacedKpiActivation(4);
    expect(result.activateLabel).toBe('Scroll to unplaced resources');
    expect(typeof result.onActivate).toBe('function');
  });
});

describe('scrollAndHighlight (Requirement 1.2)', () => {
  it('does nothing if the target element does not exist (no throw)', () => {
    expect(() => scrollAndHighlight('does-not-exist')).not.toThrow();
  });

  it('scrolls the target into view and applies the highlight class, removing it after >=1.5s', () => {
    const el = document.createElement('div');
    el.id = 'test-scroll-target';
    el.scrollIntoView = vi.fn();
    document.body.appendChild(el);

    vi.useFakeTimers();
    scrollAndHighlight('test-scroll-target');

    expect(el.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
    expect(el.classList.contains('infra-map-highlight-pulse')).toBe(true);

    // Not yet removed before 1.5s.
    vi.advanceTimersByTime(1400);
    expect(el.classList.contains('infra-map-highlight-pulse')).toBe(true);

    vi.advanceTimersByTime(200);
    expect(el.classList.contains('infra-map-highlight-pulse')).toBe(false);

    vi.useRealTimers();
    document.body.removeChild(el);
  });
});
