import { randomLcg } from "d3-random";
import { describe, expect, it } from "vitest";
import { buildBadges } from "./badge";

describe("buildBadges", () => {
  it("is deterministic for a seed", () => {
    expect(buildBadges(8, randomLcg(7))).toEqual(buildBadges(8, randomLcg(7)));
  });

  it("returns the requested count of distinct ids", () => {
    const badges = buildBadges(12, randomLcg(99));
    expect(badges).toHaveLength(12);
    expect(new Set(badges.map((badge) => badge.id)).size).toBe(12);
  });

  it("mints badge-shaped ids", () => {
    for (const badge of buildBadges(20, randomLcg(3))) {
      expect(badge.id).toMatch(/^B\d{3,}$/);
    }
  });

  it("gives every badge a staff grade ceiling in [2, 4]", () => {
    for (const badge of buildBadges(30, randomLcg(11))) {
      expect(Number.isInteger(badge.grade)).toBe(true);
      expect(badge.grade).toBeGreaterThanOrEqual(2);
      expect(badge.grade).toBeLessThanOrEqual(4);
    }
  });

  it("rejects a count that is not a finite non-negative integer", () => {
    expect(() => buildBadges(Number.POSITIVE_INFINITY, randomLcg(1))).toThrow(
      /non-negative integer/,
    );
    expect(() => buildBadges(-1, randomLcg(1))).toThrow(/non-negative integer/);
    expect(() => buildBadges(3.5, randomLcg(1))).toThrow(/non-negative integer/);
  });
});
