import { describe, expect, it } from "vitest";
import type { Wave } from "./scenario";
import { waveStateAt } from "./wave-state";

const ONE_WAVE: Wave[] = [{ startTick: 10, durationTicks: 5, eventsPerTick: 2 }];

describe("waveStateAt: empty waves", () => {
  it("reads calm with every field null, at any tick", () => {
    expect(waveStateAt(0, [], 3)).toEqual({
      phase: "calm",
      index: null,
      ticksUntilNext: null,
      eventsPerTick: null,
    });
    expect(waveStateAt(999, [], 3)).toEqual({
      phase: "calm",
      index: null,
      ticksUntilNext: null,
      eventsPerTick: null,
    });
  });
});

describe("waveStateAt: single wave, half-open boundaries", () => {
  it("reads calm well before the wave, with the wave's index and countdown", () => {
    expect(waveStateAt(0, ONE_WAVE, 3)).toEqual({
      phase: "calm",
      index: 0,
      ticksUntilNext: 10,
      eventsPerTick: null,
    });
  });

  it("reads incoming exactly warnTicks before startTick (the near edge)", () => {
    expect(waveStateAt(7, ONE_WAVE, 3)).toEqual({
      phase: "incoming",
      index: 0,
      ticksUntilNext: 3,
      eventsPerTick: null,
    });
  });

  it("reads calm one tick outside the warn window (the far edge)", () => {
    expect(waveStateAt(6, ONE_WAVE, 3)).toEqual({
      phase: "calm",
      index: 0,
      ticksUntilNext: 4,
      eventsPerTick: null,
    });
  });

  it("reads incoming one tick before the wave starts", () => {
    expect(waveStateAt(9, ONE_WAVE, 3)).toEqual({
      phase: "incoming",
      index: 0,
      ticksUntilNext: 1,
      eventsPerTick: null,
    });
  });

  it("reads active at the wave's first tick (startTick is included)", () => {
    expect(waveStateAt(10, ONE_WAVE, 3)).toEqual({
      phase: "active",
      index: 0,
      ticksUntilNext: null,
      eventsPerTick: 2,
    });
  });

  it("reads active at the wave's last included tick (half-open end)", () => {
    expect(waveStateAt(14, ONE_WAVE, 3)).toEqual({
      phase: "active",
      index: 0,
      ticksUntilNext: null,
      eventsPerTick: 2,
    });
  });

  it("reads calm, with a null index, at the wave's end tick and after (no more waves)", () => {
    expect(waveStateAt(15, ONE_WAVE, 3)).toEqual({
      phase: "calm",
      index: null,
      ticksUntilNext: null,
      eventsPerTick: null,
    });
    expect(waveStateAt(1000, ONE_WAVE, 3)).toEqual({
      phase: "calm",
      index: null,
      ticksUntilNext: null,
      eventsPerTick: null,
    });
  });
});

describe("waveStateAt: precedence when the next wave's warn window opens during the current wave", () => {
  const OVERLAPPING: Wave[] = [
    { startTick: 0, durationTicks: 10, eventsPerTick: 1 },
    { startTick: 10, durationTicks: 5, eventsPerTick: 5 },
  ];

  it("reads active for wave 0, not incoming for wave 1, even though wave 1's warn window is open", () => {
    // warnTicks=5: at tick 6, wave 1 starts at 10, so ticksUntilNext (4) <= warnTicks (5)
    // would read "incoming" in isolation, but tick 6 is still inside wave 0.
    expect(waveStateAt(6, OVERLAPPING, 5)).toEqual({
      phase: "active",
      index: 0,
      ticksUntilNext: null,
      eventsPerTick: 1,
    });
  });

  it("moves to incoming for wave 1 once wave 0 ends", () => {
    expect(waveStateAt(10, OVERLAPPING, 5)).toEqual({
      phase: "active",
      index: 1,
      ticksUntilNext: null,
      eventsPerTick: 5,
    });
  });
});

describe("waveStateAt: multi-wave index and countdown values", () => {
  const THREE: Wave[] = [
    { startTick: 0, durationTicks: 4, eventsPerTick: 1 },
    { startTick: 10, durationTicks: 4, eventsPerTick: 2 },
    { startTick: 20, durationTicks: 4, eventsPerTick: 3 },
  ];

  it("reports the next wave's index and countdown from a calm gap between waves", () => {
    expect(waveStateAt(5, THREE, 2)).toEqual({
      phase: "calm",
      index: 1,
      ticksUntilNext: 5,
      eventsPerTick: null,
    });
  });

  it("reports the second wave's index and rate while it is active", () => {
    expect(waveStateAt(11, THREE, 2)).toEqual({
      phase: "active",
      index: 1,
      ticksUntilNext: null,
      eventsPerTick: 2,
    });
  });

  it("reports the third wave's index and countdown while incoming, after wave 2 ends", () => {
    expect(waveStateAt(19, THREE, 2)).toEqual({
      phase: "incoming",
      index: 2,
      ticksUntilNext: 1,
      eventsPerTick: null,
    });
  });
});
