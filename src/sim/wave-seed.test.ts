import { describe, expect, it } from "vitest";
import { waveSeed } from "./wave-seed";

// GH126-PLAN.md M2a seam 10: a wave replays identically given its trigger tick, so
// this must be a pure, deterministic function of (runSeed, triggerTick) alone.
describe("waveSeed", () => {
  it("is deterministic for the same run seed and trigger tick", () => {
    expect(waveSeed(7, 500)).toBe(waveSeed(7, 500));
  });

  it("differs across trigger ticks for the same run seed", () => {
    expect(waveSeed(7, 500)).not.toBe(waveSeed(7, 600));
  });

  it("differs across run seeds for the same trigger tick", () => {
    expect(waveSeed(7, 500)).not.toBe(waveSeed(8, 500));
  });

  it("returns a finite, non-negative integer suitable for randomLcg", () => {
    const seed = waveSeed(7, 500);
    expect(Number.isInteger(seed)).toBe(true);
    expect(seed).toBeGreaterThanOrEqual(0);
  });
});
