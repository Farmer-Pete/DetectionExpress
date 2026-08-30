import { afterEach, describe, expect, it, vi } from "vitest";
import { hasSeenIntro, markIntroSeen } from "./onboarding-storage";

// The shared cleanup clears localStorage after each test. Restore any stubbed
// globals or spies this file installs so a stub never leaks to the next case.
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("onboarding-storage", () => {
  it("reads false when the flag is unset", () => {
    expect(hasSeenIntro()).toBe(false);
  });

  it("persists true after markIntroSeen", () => {
    markIntroSeen();
    expect(hasSeenIntro()).toBe(true);
  });

  it("reads false when localStorage is absent", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(hasSeenIntro()).toBe(false);
  });

  it("reads false when a read throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(hasSeenIntro()).toBe(false);
  });

  it("never throws when a write throws", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => markIntroSeen()).not.toThrow();
  });

  it("never throws when localStorage is absent on write", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(() => markIntroSeen()).not.toThrow();
  });
});
