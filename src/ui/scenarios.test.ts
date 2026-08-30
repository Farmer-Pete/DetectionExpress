import { describe, expect, it } from "vitest";
import { SCENARIO_SLUGS, scenarioFileName, scenarioSlug } from "./scenarios";

// The slug pattern the dev plugin (`src/dev/algorithms-hmr.ts`) validates a slug
// against before it touches the filesystem. A slug also caps at this length.
const SLUG_PATTERN = /^[a-z0-9-]{1,64}$/;
const MAX_SLUGS = 64;

describe("scenarios", () => {
  it("maps every Scenario id to a slug that matches the dev plugin's slug pattern", () => {
    for (const slug of Object.values(SCENARIO_SLUGS)) {
      expect(slug).toMatch(SLUG_PATTERN);
    }
  });

  it("is injective: no two Scenario ids share a slug", () => {
    const slugs = Object.values(SCENARIO_SLUGS);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("keeps the Scenario count below the per-slug cap", () => {
    expect(Object.keys(SCENARIO_SLUGS).length).toBeLessThan(MAX_SLUGS);
  });

  it("resolves the kiosk-pin-attack scenario to its slug", () => {
    expect(scenarioSlug("kiosk-pin-attack")).toBe("kiosk-pin-attack");
  });

  it("rejects an unknown scenario id rather than inventing a slug", () => {
    expect(() => scenarioSlug("no-such-scenario")).toThrow();
  });

  it("builds the src/algorithms/<slug>.ts filename the editor's download uses", () => {
    expect(scenarioFileName("kiosk-pin-attack")).toBe("kiosk-pin-attack.ts");
  });
});
