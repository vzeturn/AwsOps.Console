import { describe, it, expect, vi, beforeEach } from 'vitest';

const applyModeMock = vi.fn();
const applyDensityMock = vi.fn();

vi.mock('@cloudscape-design/global-styles', () => ({
  applyMode: (...args: unknown[]) => applyModeMock(...args),
  applyDensity: (...args: unknown[]) => applyDensityMock(...args),
  Mode: { Light: 'light', Dark: 'dark' },
  Density: { Comfortable: 'comfortable', Compact: 'compact' },
}));

const THEME_KEY = 'ops-dashboard-theme';
const DENSITY_KEY = 'ops-dashboard-density';

/** Each test needs a FRESH module instance: `useUiStore` reads `localStorage` exactly once, at
 * module-evaluation time (`create<UiState>((set, get) => ({ theme: readStoredTheme(), ... }))`),
 * so re-importing after changing `localStorage` is the only way to exercise a different starting
 * state without restructuring the store itself. */
async function freshStore() {
  vi.resetModules();
  const mod = await import('./uiStore');
  return mod;
}

beforeEach(() => {
  localStorage.clear();
  applyModeMock.mockClear();
  applyDensityMock.mockClear();
});

describe('useUiStore — theme', () => {
  it('defaults to dark when no preference is stored yet', async () => {
    const { useUiStore } = await freshStore();
    expect(useUiStore.getState().theme).toBe('dark');
  });

  it('respects a previously stored light preference', async () => {
    localStorage.setItem(THEME_KEY, 'light');
    const { useUiStore } = await freshStore();
    expect(useUiStore.getState().theme).toBe('light');
  });

  it('treats a corrupted/unknown stored value as "no preference" and falls back to dark', async () => {
    localStorage.setItem(THEME_KEY, 'sepia');
    const { useUiStore } = await freshStore();
    expect(useUiStore.getState().theme).toBe('dark');
  });

  it('setTheme persists the choice AND calls Cloudscape applyMode with the matching Mode', async () => {
    const { useUiStore } = await freshStore();
    useUiStore.getState().setTheme('light');

    expect(useUiStore.getState().theme).toBe('light');
    expect(localStorage.getItem(THEME_KEY)).toBe('light');
    expect(applyModeMock).toHaveBeenCalledWith('light');

    useUiStore.getState().setTheme('dark');
    expect(localStorage.getItem(THEME_KEY)).toBe('dark');
    expect(applyModeMock).toHaveBeenCalledWith('dark');
  });
});

describe('useUiStore — density', () => {
  it('defaults to comfortable when no preference is stored yet', async () => {
    const { useUiStore } = await freshStore();
    expect(useUiStore.getState().density).toBe('comfortable');
  });

  it('respects a previously stored compact preference', async () => {
    localStorage.setItem(DENSITY_KEY, 'compact');
    const { useUiStore } = await freshStore();
    expect(useUiStore.getState().density).toBe('compact');
  });

  it('setDensity persists the choice AND calls Cloudscape applyDensity with the matching Density', async () => {
    const { useUiStore } = await freshStore();
    useUiStore.getState().setDensity('compact');

    expect(useUiStore.getState().density).toBe('compact');
    expect(localStorage.getItem(DENSITY_KEY)).toBe('compact');
    expect(applyDensityMock).toHaveBeenCalledWith('compact');
  });
});

describe('useUiStore — sidebarCollapsed', () => {
  it('starts expanded (not collapsed) and toggleSidebar flips it each call', async () => {
    const { useUiStore } = await freshStore();
    expect(useUiStore.getState().sidebarCollapsed).toBe(false);

    useUiStore.getState().toggleSidebar();
    expect(useUiStore.getState().sidebarCollapsed).toBe(true);

    useUiStore.getState().toggleSidebar();
    expect(useUiStore.getState().sidebarCollapsed).toBe(false);
  });
});

describe('initializeUiChrome', () => {
  it('applies the CURRENT persisted theme and density without changing them', async () => {
    localStorage.setItem(THEME_KEY, 'light');
    localStorage.setItem(DENSITY_KEY, 'compact');
    const { initializeUiChrome, useUiStore } = await freshStore();

    applyModeMock.mockClear();
    applyDensityMock.mockClear();
    initializeUiChrome();

    expect(applyModeMock).toHaveBeenCalledWith('light');
    expect(applyDensityMock).toHaveBeenCalledWith('compact');
    expect(useUiStore.getState().theme).toBe('light');
    expect(useUiStore.getState().density).toBe('compact');
  });
});
