// Vitest setup file. The happy-dom environment supplies the DOM, so importing
// Testing Library here is safe. Unmounts rendered components between tests to keep
// the DOM clean, and clears localStorage so the onboarding seen flag never leaks
// from one case into the next.
//
// happy-dom exposes the `Storage` class but does not wire a `localStorage` onto the
// global, so this setup installs one real store. The app reads it through the guarded
// `onboarding-storage` wrapper, so production uses the browser's own `localStorage`.

import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

if (globalThis.localStorage === undefined) {
  Object.defineProperty(globalThis, "localStorage", {
    value: new Storage(),
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  cleanup();
  localStorage.clear();
});
