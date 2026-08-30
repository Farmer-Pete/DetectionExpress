import { describe, expect, it } from "vitest";
import { CORPUS_PEAK_EVENTS_PER_TICK, WAVE_RATES } from "../tuning";
import {
  NAIVE_CODE_PER_ANCHOR,
  naiveCost,
  REFERENCE_FAST_RATE,
  REFERENCE_SLOW_RATE,
  rateFor,
  TALLY_CODE_PER_ANCHOR,
} from "./kiosk-band-calibration";

describe("the kiosk counted-cost model", () => {
  it("prices the naive scan by its density-driven cost and the tally far cheaper", () => {
    // The naive scan's cost RISES with density, so pricing it at peak is its
    // worst case. Assert that growth rather than the tautology that the anchor
    // priced against itself is 1.
    expect(naiveCost(CORPUS_PEAK_EVENTS_PER_TICK)).toBeGreaterThan(naiveCost(WAVE_RATES[0] ?? 1));
    // The naive scan is the anchor, so its code-per-anchor sits at 1; the O(1)
    // tally reads far higher, so the separation ratio is large.
    expect(TALLY_CODE_PER_ANCHOR).toBeGreaterThan(NAIVE_CODE_PER_ANCHOR);
    expect(TALLY_CODE_PER_ANCHOR).toBeGreaterThan(10);
  });

  it("fixes the naive multiplier at 1: it is its own anchor", () => {
    expect(NAIVE_CODE_PER_ANCHOR).toBe(1);
  });
});

describe("rateFor", () => {
  it("scales linearly with omega and skew", () => {
    const base = rateFor(1, 10, 1);
    const doubledOmega = rateFor(1, 20, 1);
    const doubledSkew = rateFor(1, 10, 2);
    expect(doubledOmega.num / doubledOmega.den).toBeCloseTo((base.num / base.den) * 2, 6);
    expect(doubledSkew.num / doubledSkew.den).toBeCloseTo((base.num / base.den) * 2, 6);
  });
});

describe("the two locked reference rates", () => {
  it("sits the slow rate near 20 events per tick", () => {
    const slow = REFERENCE_SLOW_RATE.num / REFERENCE_SLOW_RATE.den;
    expect(slow).toBeGreaterThan(15);
    expect(slow).toBeLessThan(25);
  });

  it("sits the fast rate near 368 events per tick, well above the slow rate", () => {
    const fast = REFERENCE_FAST_RATE.num / REFERENCE_FAST_RATE.den;
    expect(fast).toBeGreaterThan(300);
    expect(fast).toBeLessThan(450);
    const slow = REFERENCE_SLOW_RATE.num / REFERENCE_SLOW_RATE.den;
    expect(fast).toBeGreaterThan(slow * 10);
  });
});
