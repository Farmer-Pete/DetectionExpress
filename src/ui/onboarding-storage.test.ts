import { afterEach, describe, expect, it, vi } from "vitest";
import { hasSeenIntro, hasSeenTour, markIntroSeen, markTourSeen } from "./onboarding-storage";

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

// The tour's own flag (GH132-PLAN.md M2): a fresh key, `detection-express:tour-seen`,
// so a player who already dismissed the old intro still sees the new tour once. Same
// guarded try/catch pattern as the intro's own functions above.
describe("onboarding-storage tour flag", () => {
  it("reads false when the flag is unset", () => {
    expect(hasSeenTour()).toBe(false);
  });

  it("persists true after markTourSeen", () => {
    markTourSeen();
    expect(hasSeenTour()).toBe(true);
  });

  it("is independent of the intro's own seen flag", () => {
    markIntroSeen();
    expect(hasSeenTour()).toBe(false);
    markTourSeen();
    expect(hasSeenIntro()).toBe(true);
  });

  it("reads false when localStorage is absent", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(hasSeenTour()).toBe(false);
  });

  it("reads false when a read throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(hasSeenTour()).toBe(false);
  });

  it("never throws when a write throws", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => markTourSeen()).not.toThrow();
  });

  it("never throws when localStorage is absent on write", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(() => markTourSeen()).not.toThrow();
  });
});
