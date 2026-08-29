import { describe, expect, it } from "bun:test";
import { DEV_KIT, loadDevHostClient } from "./dev-flag";

// The test preload (src/test/dev-kit-flag.ts) sets `PUBLIC_DEV_KIT` in process.env, so
// the whole suite runs with the dev branch live. These tests pin that wiring: if the
// preload were dropped, DEV_KIT would read false and the dev code would go untested.
describe("dev-flag", () => {
  it("reads the dev-kit flag as true under the test preload", () => {
    expect(DEV_KIT).toBe(true);
  });

  it("loads the dev-host client module when the dev kit is on", async () => {
    const pending = loadDevHostClient();
    expect(pending).not.toBeNull();
    const mod = await pending;
    expect(mod?.createDevHostClient).toBeInstanceOf(Function);
  });

  // ARCHITECTURE.md: `src/game/` may import React only in the store. dev-flag lives in
  // game/, so it must carry no `react` import — not even a type-only one.
  it("does not import from react", async () => {
    const source = await Bun.file(new URL("./dev-flag.ts", import.meta.url)).text();
    expect(source).not.toMatch(/from\s+["']react["']/);
  });
});
