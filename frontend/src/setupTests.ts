import '@testing-library/jest-dom/vitest';

/**
 * Node >=22 has `--experimental-webstorage` enabled by default, defining `globalThis.localStorage`
 * with Node's own accessor (not jsdom's) that returns `undefined` outside a real browser context —
 * this shadows the `window.localStorage` that jsdom provides, causing `uiStore.ts` (which uses
 * `localStorage.getItem`) to throw in tests. Minimal polyfill with an in-memory Storage so this
 * doesn't depend on a Node flag or environment variable.
 */
if (typeof localStorage === 'undefined' || typeof localStorage?.getItem !== 'function') {
  class MemoryStorage implements Storage {
    private store = new Map<string, string>();
    get length() {
      return this.store.size;
    }
    clear() {
      this.store.clear();
    }
    getItem(key: string) {
      return this.store.has(key) ? (this.store.get(key) as string) : null;
    }
    key(index: number) {
      return Array.from(this.store.keys())[index] ?? null;
    }
    removeItem(key: string) {
      this.store.delete(key);
    }
    setItem(key: string, value: string) {
      this.store.set(key, String(value));
    }
  }
  Object.defineProperty(globalThis, 'localStorage', {
    value: new MemoryStorage(),
    writable: true,
    configurable: true,
  });
}

/** jsdom does not implement `window.matchMedia` — Cloudscape's `applyMode`/`applyDensity` and some
 * components probe it for the OS-level dark-mode preference. */
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

/** jsdom does not implement `ResizeObserver` — several Cloudscape components (Table, AppLayout,
 * charts) observe their own container size and throw `ResizeObserver is not defined` without this. */
if (typeof globalThis.ResizeObserver === 'undefined') {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
}

/** jsdom does not implement `Element.scrollIntoView` (it has no real layout engine to scroll) —
 * `cmdk`'s `Command.List` calls it on the highlighted item whenever the selection changes. */
if (typeof Element !== 'undefined' && typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = () => {};
}


