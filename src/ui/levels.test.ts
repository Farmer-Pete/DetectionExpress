import { describe, expect, it } from "bun:test";
import { LEVEL_SLUGS, levelFileName, levelSlug } from "./levels";

const SLUG_PATTERN = /^[a-z0-9-]{1,64}$/;
// Mirrors the host's DEVHOST_MAX_SLUGS cap (dd-dev.mjs). The host is untyped JS, so
// the test asserts against the same small number rather than importing it, and the
// host's own build check guards the packaged level count against the real constant.
const DEVHOST_MAX_SLUGS = 64;

describe("levels", () => {
  it("maps every level id to a slug that matches the host's slug pattern", () => {
    for (const slug of Object.values(LEVEL_SLUGS)) {
      expect(slug).toMatch(SLUG_PATTERN);
    }
  });

  it("is injective: no two level ids share a slug", () => {
    const slugs = Object.values(LEVEL_SLUGS);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("keeps the level count below the host's per-slug channel cap", () => {
    expect(Object.keys(LEVEL_SLUGS).length).toBeLessThan(DEVHOST_MAX_SLUGS);
  });

  it("resolves the kiosk-pin-attack scenario to its slug", () => {
    expect(levelSlug("kiosk-pin-attack")).toBe("kiosk-pin-attack");
  });

  it("rejects an unknown scenario id rather than inventing a slug", () => {
    expect(() => levelSlug("no-such-level")).toThrow();
  });

  it("builds the on-disk Algorithm filename the dev host writes for a slug", () => {
    expect(levelFileName("kiosk-pin-attack")).toBe("detection-express-kiosk-pin-attack.js");
  });
});
