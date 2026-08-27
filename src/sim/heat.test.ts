import { describe, expect, it } from "bun:test";
import { nextHeat, occupancy } from "./heat";

const THRESHOLD = 0.5;
const RAMP = 1 / (2.5 * 20); // HEAT_RAMP_S * PUBLISH_HZ
const COOL = 1 / (2.0 * 20); // HEAT_COOL_S * PUBLISH_HZ

/** Fold an occupancy history into a final heat, from calm. */
function heatOver(history: number[]): number {
  let heat = 0;
  for (const occ of history) {
    heat = nextHeat(heat, occ, THRESHOLD, RAMP, COOL);
  }
  return heat;
}

describe("occupancy", () => {
  it("is size over capacity", () => {
    expect(occupancy(30, 100)).toBeCloseTo(0.3, 10);
  });

  it("is zero for a source with no input channel", () => {
    expect(occupancy(0, 0)).toBe(0);
  });
});

describe("nextHeat", () => {
  it("rises while occupancy stays above the threshold", () => {
    const ramped = heatOver(new Array(10).fill(0.9));
    expect(ramped).toBeCloseTo(10 * RAMP, 10);
    expect(ramped).toBeGreaterThan(0);
  });

  it("reaches and clamps at full red under sustained fill", () => {
    const ramped = heatOver(new Array(200).fill(1));
    expect(ramped).toBe(1);
  });

  it("cools back down once occupancy drops", () => {
    const hot = heatOver(new Array(200).fill(1));
    let heat = hot;
    for (let i = 0; i < 5; i++) {
      heat = nextHeat(heat, 0, THRESHOLD, RAMP, COOL);
    }
    expect(heat).toBeCloseTo(1 - 5 * COOL, 10);
    expect(heat).toBeLessThan(hot);
  });

  it("keeps a one-sample spike below the strobe line", () => {
    const spike = heatOver([0, 0, 0.95, 0, 0]);
    expect(spike).toBeLessThan(0.6); // HEAT_STROBE
    expect(spike).toBe(0); // cooled straight back to calm
  });

  it("keeps a source at zero heat", () => {
    const source = heatOver(new Array(50).fill(0));
    expect(source).toBe(0);
  });
});
