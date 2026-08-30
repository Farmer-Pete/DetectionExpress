// Vitest setup file. The happy-dom environment supplies the DOM, so importing
// Testing Library here is safe. Unmounts rendered components between tests to keep
// the DOM clean, and clears localStorage so the onboarding seen flag never leaks
// from one case into the next.
//
// Under the pinned Node 26 runtime a global `localStorage` already exists, so the
// guard below installs a store only when none is present. Either way the app reads it
// through the guarded `onboarding-storage` wrapper, and the `localStorage.clear()`
// after each test keeps the onboarding seen flag from leaking between cases.

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
