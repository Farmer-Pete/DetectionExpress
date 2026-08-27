import { describe, expect, it } from "bun:test";
import { ema, emaAlpha, perSecond } from "./rate";

describe("perSecond", () => {
  it("turns a per-sample count delta into events per second", () => {
    // 3 events over 3 ticks at 60 ticks/sec is 60 events/sec.
    expect(perSecond(3, 3, 60)).toBe(60);
  });

  it("is zero when no ticks elapsed", () => {
    expect(perSecond(5, 0, 60)).toBe(0);
  });
});

describe("emaAlpha", () => {
  it("derives the smoothing factor from tau and the publish rate", () => {
    expect(emaAlpha(0.4, 20)).toBeCloseTo(1 - Math.exp(-1 / (0.4 * 20)), 12);
  });
});

describe("ema", () => {
  it("holds a steady signal at its value", () => {
    const alpha = emaAlpha(0.4, 20);
    let value = 40;
    for (let i = 0; i < 100; i++) {
      value = ema(value, 40, alpha);
    }
    expect(value).toBeCloseTo(40, 6);
  });

  it("converges from a fed history of samples toward the input level", () => {
    const alpha = emaAlpha(0.4, 20);
    let value = 0;
    for (let i = 0; i < 200; i++) {
      value = ema(value, 8, alpha);
    }
    expect(value).toBeCloseTo(8, 4);
  });

  it("moves one step toward a new sample by exactly alpha", () => {
    const alpha = 0.25;
    expect(ema(0, 100, alpha)).toBe(25);
  });
});
