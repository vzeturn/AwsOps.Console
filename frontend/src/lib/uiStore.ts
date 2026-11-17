import { create } from 'zustand';
import { applyDensity, applyMode, Density, Mode } from '@cloudscape-design/global-styles';

/**
 * Client/UI state (theme, density, sidebar) — Zustand, separate from server state (TanStack
 * Query owns everything that comes from the API). This is the "4 buckets" model that has become
 * the 2026 default for React state: server state / client UI state / URL state / global app
 * state — theme and density are global APP state that must survive navigation and persist across
 * reloads, which is exactly Zustand's use case here (a plain `useState` in a layout component
 * would reset on remount).
 *
 * Cloudscape's own `applyMode`/`applyDensity` (from `@cloudscape-design/global-styles`) are the
 * SOURCE OF TRUTH for what the components actually render — they mutate a `data-*` attribute
 * Cloudscape's CSS reads. This store's job is only to remember the user's CHOICE across reloads
 * and expose it to React for the settings UI; the actual visual effect always goes through
 * Cloudscape's own functions, never a hand-rolled CSS class.
 */

type ThemeMode = 'light' | 'dark';
type DensityMode = 'comfortable' | 'compact';

const THEME_KEY = 'ops-dashboard-theme';
const DENSITY_KEY = 'ops-dashboard-density';

function readStoredTheme(): ThemeMode {
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === 'light' || stored === 'dark') return stored;
  // Dark-first default (no stored preference yet) — matches the density/information-dense,
  // low-glare convention of the enterprise ops consoles this rebuild is modeled on, while still
  // respecting an explicit user choice once one is made.
  return 'dark';
}

function readStoredDensity(): DensityMode {
  const stored = localStorage.getItem(DENSITY_KEY);
  return stored === 'compact' ? 'compact' : 'comfortable';
}

interface UiState {
  theme: ThemeMode;
  density: DensityMode;
  sidebarCollapsed: boolean;
  setTheme: (theme: ThemeMode) => void;
  setDensity: (density: DensityMode) => void;
  toggleSidebar: () => void;
}

export const useUiStore = create<UiState>((set, get) => ({
  theme: readStoredTheme(),
  density: readStoredDensity(),
  sidebarCollapsed: false,
  setTheme: (theme) => {
    localStorage.setItem(THEME_KEY, theme);
    applyMode(theme === 'dark' ? Mode.Dark : Mode.Light);
    set({ theme });
  },
  setDensity: (density) => {
    localStorage.setItem(DENSITY_KEY, density);
    applyDensity(density === 'compact' ? Density.Compact : Density.Comfortable);
    set({ density });
  },
  toggleSidebar: () => set({ sidebarCollapsed: !get().sidebarCollapsed }),
}));

/** Applies the persisted theme/density to the document — call ONCE, at app startup, before the
 * first paint of any Cloudscape component (see `main.tsx`). */
export function initializeUiChrome(): void {
  const { theme, density } = useUiStore.getState();
  applyMode(theme === 'dark' ? Mode.Dark : Mode.Light);
  applyDensity(density === 'compact' ? Density.Compact : Density.Comfortable);
}
