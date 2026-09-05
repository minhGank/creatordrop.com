import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

const runtimeGlobal: { readonly window?: Window } = globalThis;

const installDefaultMatchMedia = (): void => {
  if (runtimeGlobal.window === undefined) return;
  Object.defineProperty(runtimeGlobal.window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      addEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
      matches: false,
      media: query,
      onchange: null,
      removeEventListener: vi.fn(),
    })),
    writable: true,
  });
};

installDefaultMatchMedia();

afterEach(() => {
  cleanup();
  if (typeof window !== 'undefined') window.sessionStorage.clear();
  installDefaultMatchMedia();
});
