import { describe, expect, it } from "vitest";
import { SCENARIO_SLUGS, scenarioFileName, scenarioSlug } from "./scenarios";

const SLUG_PATTERN = /^[a-z0-9-]{1,64}$/;
// Mirrors the host's DEVHOST_MAX_SLUGS cap (dd-dev.mjs). The host is untyped JS, so
// the test asserts against the same small number rather than importing it, and the
// host's own build check guards the packaged Scenario count against the real constant.
const DEVHOST_MAX_SLUGS = 64;

describe("scenarios", () => {
  it("maps every Scenario id to a slug that matches the host's slug pattern", () => {
    for (const slug of Object.values(SCENARIO_SLUGS)) {
      expect(slug).toMatch(SLUG_PATTERN);
    }
  });

  it("is injective: no two Scenario ids share a slug", () => {
    const slugs = Object.values(SCENARIO_SLUGS);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("keeps the Scenario count below the host's per-slug channel cap", () => {
    expect(Object.keys(SCENARIO_SLUGS).length).toBeLessThan(DEVHOST_MAX_SLUGS);
  });

  it("resolves the kiosk-pin-attack scenario to its slug", () => {
    expect(scenarioSlug("kiosk-pin-attack")).toBe("kiosk-pin-attack");
  });

  it("rejects an unknown scenario id rather than inventing a slug", () => {
    expect(() => scenarioSlug("no-such-scenario")).toThrow();
  });

  it("builds the on-disk Algorithm filename the dev host writes for a slug", () => {
    expect(scenarioFileName("kiosk-pin-attack")).toBe("detection-express-kiosk-pin-attack.js");
  });
});
