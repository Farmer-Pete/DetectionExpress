import { afterEach, describe, expect, it, vi } from "vitest";
import { readShortcutsEnabled, writeShortcutsEnabled } from "./shortcuts-preference";

// The shared cleanup clears localStorage after each test (src/test/cleanup.ts),
// mirroring onboarding-storage.test.ts. Restore any stubbed globals or spies this
// file installs so a stub never leaks to the next case.
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("shortcuts-preference", () => {
  it("reads true (enabled) when no preference has ever been written", () => {
    expect(readShortcutsEnabled()).toBe(true);
  });

  it("reads false after writeShortcutsEnabled(false)", () => {
    writeShortcutsEnabled(false);
    expect(readShortcutsEnabled()).toBe(false);
  });

  it("reads true again after writeShortcutsEnabled(true) undoes an off write", () => {
    writeShortcutsEnabled(false);
    writeShortcutsEnabled(true);
    expect(readShortcutsEnabled()).toBe(true);
  });

  it("reads true when localStorage is absent", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(readShortcutsEnabled()).toBe(true);
  });

  it("reads true when a read throws (a blocked store must not silently disable every mnemonic)", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readShortcutsEnabled()).toBe(true);
  });

  it("never throws when a write throws", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => writeShortcutsEnabled(false)).not.toThrow();
  });

  it("never throws when localStorage is absent on write", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(() => writeShortcutsEnabled(false)).not.toThrow();
  });
});
