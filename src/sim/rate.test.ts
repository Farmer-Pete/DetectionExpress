import { describe, expect, it } from "bun:test";
import { ema, emaAlpha, makeWindowedRate, perSecond } from "./rate";

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

describe("makeWindowedRate", () => {
  it("averages a steady stream into a steady rate", () => {
    const rate = makeWindowedRate(10, 20); // 10 samples at 20 Hz is a 0.5s window
    let out = 0;
    for (let i = 0; i < 30; i++) {
      out = rate(1); // one completion per 50ms sample is 20 per second
    }
    expect(out).toBeCloseTo(20, 6);
  });

  it("smooths a spiky input to its window mean", () => {
    const rate = makeWindowedRate(10, 20);
    let out = 0;
    for (let i = 0; i < 40; i++) {
      out = rate(i % 2); // alternating 0 and 1 averages to 0.5 per sample, so 10 per second
    }
    expect(out).toBeCloseTo(10, 6);
  });

  it("zero-pads the warm-up so the reading ramps up over the first window", () => {
    const rate = makeWindowedRate(10, 20); // fixed 10-sample window
    expect(rate(1)).toBe(2); // 1 completion over the fixed window: 1 * 20 / 10
    expect(rate(1)).toBe(4); // 2 completions over the fixed window: 2 * 20 / 10
  });
});
