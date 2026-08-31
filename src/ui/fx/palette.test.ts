import { describe, expect, it } from "vitest";
import { createHuntPalette, huntColorVar, PALETTE_SIZE } from "./palette";

describe("hunt palette", () => {
  it("assigns the next slot to a reason token's first appearance", () => {
    const palette = createHuntPalette();
    expect(palette.colorFor("brute")).toBe(huntColorVar(0));
    expect(palette.colorFor("travel")).toBe(huntColorVar(1));
    expect(palette.colorFor("privilege")).toBe(huntColorVar(2));
  });

  it("reserves a slot on a watch's reason too: colorFor does not care about state", () => {
    // The palette itself is state-agnostic; FxLayer calls colorFor for a watch's
    // reason exactly as it does for a hit's, so a watch reserves a slot on its own
    // first appearance without ever firing a landing.
    const palette = createHuntPalette();
    expect(palette.colorFor("watch-only-reason")).toBe(huntColorVar(0));
  });

  it("returns the same slot for a reason it has already assigned", () => {
    const palette = createHuntPalette();
    palette.colorFor("brute");
    palette.colorFor("travel");
    expect(palette.colorFor("brute")).toBe(huntColorVar(0));
    expect(palette.colorFor("travel")).toBe(huntColorVar(1));
  });

  it("cycles back to the first slot once every slot is taken", () => {
    const palette = createHuntPalette();
    for (let i = 0; i < PALETTE_SIZE; i++) {
      expect(palette.colorFor(`reason-${i}`)).toBe(huntColorVar(i));
    }
    expect(palette.colorFor(`reason-${PALETTE_SIZE}`)).toBe(huntColorVar(0));
    expect(palette.colorFor(`reason-${PALETTE_SIZE + 1}`)).toBe(huntColorVar(1));
  });

  it("resets assignment on demand, so the next reason claims slot 0 again", () => {
    const palette = createHuntPalette();
    palette.colorFor("brute");
    palette.colorFor("travel");
    palette.reset();
    expect(palette.colorFor("travel")).toBe(huntColorVar(0));
    expect(palette.colorFor("brute")).toBe(huntColorVar(1));
  });
});
