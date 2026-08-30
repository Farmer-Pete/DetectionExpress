import { describe, expect, it } from "vitest";
import type { Wave } from "../scenario";
import { admitArrivals } from "./admission";

/** One tick per admitted arrival, from a wave's own fractional accumulator, reset per wave. */
function kioskAccumulator(wave: Wave): number[] {
  const arrivals: number[] = [];
  let acc = 0;
  const endTick = wave.startTick + wave.durationTicks;
  for (let tick = wave.startTick; tick < endTick; tick++) {
    acc += wave.eventsPerTick;
    while (acc >= 1) {
      acc -= 1;
      arrivals.push(tick);
    }
  }
  return arrivals;
}

describe("admitArrivals: integer rates", () => {
  it("admits exactly eventsPerTick arrivals on every tick of a whole-rate wave", () => {
    const wave: Wave = { startTick: 10, durationTicks: 5, eventsPerTick: 3 };
    const arrivals = admitArrivals([wave]);
    expect(arrivals).toEqual([10, 10, 10, 11, 11, 11, 12, 12, 12, 13, 13, 13, 14, 14, 14]);
  });

  it("admits none in the intro before the first wave", () => {
    const wave: Wave = { startTick: 100, durationTicks: 3, eventsPerTick: 2 };
    const arrivals = admitArrivals([wave]);
    expect(arrivals.every((tick) => tick >= 100)).toBe(true);
  });

  it("admits none inside a drain gap between waves", () => {
    const waves: Wave[] = [
      { startTick: 0, durationTicks: 5, eventsPerTick: 1 },
      { startTick: 10, durationTicks: 5, eventsPerTick: 1 }, // gap: ticks 5..9
    ];
    const arrivals = admitArrivals(waves);
    for (const tick of arrivals) {
      expect(tick < 5 || tick >= 10).toBe(true);
    }
  });

  it("resets the accumulator at the start of each wave", () => {
    // Wave 1 ends with a carried fraction that would spill into a tick 5 if not
    // reset; Wave 2 must not inherit it.
    const waves: Wave[] = [
      { startTick: 0, durationTicks: 4, eventsPerTick: 1.5 },
      { startTick: 10, durationTicks: 2, eventsPerTick: 1 },
    ];
    const arrivals = admitArrivals(waves);
    const wave2Arrivals = arrivals.filter((tick) => tick >= 10);
    expect(wave2Arrivals).toEqual([10, 11]);
  });
});

describe("admitArrivals: fractional-rate parity against the kiosk accumulator", () => {
  it("matches the kiosk accumulator's per-wave sequence for a fractional rate", () => {
    const waves: Wave[] = [
      { startTick: 0, durationTicks: 20, eventsPerTick: 0.7 },
      { startTick: 30, durationTicks: 15, eventsPerTick: 2.3 },
      { startTick: 60, durationTicks: 10, eventsPerTick: 5.05 },
    ];
    const expected = waves.flatMap(kioskAccumulator);
    expect(admitArrivals(waves)).toEqual(expected);
  });

  it("matches the kiosk accumulator across a spread of fractional rates and durations", () => {
    const waves: Wave[] = [
      { startTick: 0, durationTicks: 7, eventsPerTick: 0.1 },
      { startTick: 50, durationTicks: 33, eventsPerTick: 1.9999 },
      { startTick: 200, durationTicks: 1, eventsPerTick: 4.5 },
      { startTick: 500, durationTicks: 50, eventsPerTick: 0.001 },
    ];
    const expected = waves.flatMap(kioskAccumulator);
    expect(admitArrivals(waves)).toEqual(expected);
  });
});

describe("admitArrivals: empty and boundary waves", () => {
  it("returns an empty array for no waves", () => {
    expect(admitArrivals([])).toEqual([]);
  });

  it("admits nothing from a zero-duration wave", () => {
    expect(admitArrivals([{ startTick: 0, durationTicks: 0, eventsPerTick: 5 }])).toEqual([]);
  });

  it("admits nothing from a zero rate", () => {
    expect(admitArrivals([{ startTick: 0, durationTicks: 10, eventsPerTick: 0 }])).toEqual([]);
  });
});

describe("admitArrivals: bad input throws", () => {
  it("rejects a non-integer startTick", () => {
    expect(() => admitArrivals([{ startTick: 1.5, durationTicks: 1, eventsPerTick: 1 }])).toThrow();
  });

  it("rejects a negative startTick", () => {
    expect(() => admitArrivals([{ startTick: -1, durationTicks: 1, eventsPerTick: 1 }])).toThrow();
  });

  it("rejects a non-integer durationTicks", () => {
    expect(() => admitArrivals([{ startTick: 0, durationTicks: 1.5, eventsPerTick: 1 }])).toThrow();
  });

  it("rejects a negative durationTicks", () => {
    expect(() => admitArrivals([{ startTick: 0, durationTicks: -1, eventsPerTick: 1 }])).toThrow();
  });

  it("rejects a NaN eventsPerTick", () => {
    expect(() =>
      admitArrivals([{ startTick: 0, durationTicks: 1, eventsPerTick: Number.NaN }]),
    ).toThrow();
  });

  it("rejects an infinite eventsPerTick", () => {
    expect(() =>
      admitArrivals([{ startTick: 0, durationTicks: 1, eventsPerTick: Number.POSITIVE_INFINITY }]),
    ).toThrow();
  });

  it("rejects a negative eventsPerTick", () => {
    expect(() => admitArrivals([{ startTick: 0, durationTicks: 1, eventsPerTick: -1 }])).toThrow();
  });

  it("rejects two waves that overlap", () => {
    const waves: Wave[] = [
      { startTick: 0, durationTicks: 10, eventsPerTick: 1 },
      { startTick: 5, durationTicks: 10, eventsPerTick: 1 },
    ];
    expect(() => admitArrivals(waves)).toThrow();
  });

  it("rejects waves given out of order that would overlap once sorted", () => {
    const waves: Wave[] = [
      { startTick: 5, durationTicks: 10, eventsPerTick: 1 },
      { startTick: 0, durationTicks: 10, eventsPerTick: 1 },
    ];
    expect(() => admitArrivals(waves)).toThrow();
  });
});
