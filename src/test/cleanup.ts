// Second test preload. Runs after happy-dom is registered (see setup.ts), so
// importing Testing Library here is safe. Unmounts rendered components between
// tests to keep the DOM clean.

import { afterEach } from "bun:test";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
});
