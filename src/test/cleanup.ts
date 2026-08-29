// Vitest setup file. The happy-dom environment supplies the DOM, so importing
// Testing Library here is safe. Unmounts rendered components between tests to keep
// the DOM clean.

import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
});
