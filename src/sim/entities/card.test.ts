import { randomLcg } from "d3-random";
import { describe, expect, it } from "vitest";
import { buildCards } from "./card";

describe("buildCards", () => {
  it("is deterministic for a seed", () => {
    expect(buildCards(8, randomLcg(7))).toEqual(buildCards(8, randomLcg(7)));
  });

  it("returns the requested count of distinct ids", () => {
    const cards = buildCards(12, randomLcg(99));
    expect(cards).toHaveLength(12);
    expect(new Set(cards.map((card) => card.id)).size).toBe(12);
  });

  it("mints card-shaped ids", () => {
    for (const card of buildCards(20, randomLcg(3))) {
      expect(card.id).toMatch(/^C\d{2,}$/);
    }
  });
});
