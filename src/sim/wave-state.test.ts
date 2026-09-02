import { describe, expect, it } from "vitest";
import type { Wave } from "./scenario";
import type { ChaosPhase } from "./snapshot";
import { chaosWaveReading, waveStateAt } from "./wave-state";

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

  it("reads active for wave 1 at its exact start tick, the active-overlaps-next-warn-window precedence case", () => {
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

// GH126-PLAN.md M3b: the endless run carries no static wave schedule, so the sampler
// bridges the repeating chaos loop into the same WaveReading shape through this pure
// helper. It lights the existing WAVE INCOMING readout, .waveflash, .shake, and
// screen-reader announcements for chaos waves with no UI rewrite.
describe("chaosWaveReading: bridges the chaos loop into a WaveReading (GH126-PLAN.md M3b)", () => {
  it("reads active while a chaos wave is in flight", () => {
    const phase: ChaosPhase = { kind: "wave", selectedLevel: 1, activeLevel: 1 };
    expect(chaosWaveReading(phase, 30)).toEqual({
      phase: "active",
      index: 0,
      ticksUntilNext: null,
      eventsPerTick: null,
    });
  });

  it("reads calm with a countdown early in a lead-in cooldown (beyond the warn window)", () => {
    const phase: ChaosPhase = { kind: "cooldown", selectedLevel: 1, cooldownRemaining: 120 };
    expect(chaosWaveReading(phase, 30)).toEqual({
      phase: "calm",
      index: 0,
      ticksUntilNext: 120,
      eventsPerTick: null,
    });
  });

  it("reads incoming once the lead-in falls within the warn window", () => {
    const phase: ChaosPhase = { kind: "cooldown", selectedLevel: 1, cooldownRemaining: 20 };
    expect(chaosWaveReading(phase, 30)).toEqual({
      phase: "incoming",
      index: 0,
      ticksUntilNext: 20,
      eventsPerTick: null,
    });
  });

  it("reads incoming exactly at the warn-window edge (cooldownRemaining === warnTicks)", () => {
    const phase: ChaosPhase = { kind: "cooldown", selectedLevel: 1, cooldownRemaining: 30 };
    expect(chaosWaveReading(phase, 30).phase).toBe("incoming");
  });

  it("reads calm one tick outside the warn window", () => {
    const phase: ChaosPhase = { kind: "cooldown", selectedLevel: 1, cooldownRemaining: 31 };
    expect(chaosWaveReading(phase, 30).phase).toBe("calm");
  });

  it("reads calm (no wave coming) when idle", () => {
    const phase: ChaosPhase = { kind: "idle", selectedLevel: 0 };
    expect(chaosWaveReading(phase, 30)).toEqual({
      phase: "calm",
      index: null,
      ticksUntilNext: null,
      eventsPerTick: null,
    });
  });

  it("reads calm during a cooldown that will stop at level 0 (no wave coming)", () => {
    // A level-0 stop: the metro is in its final cooldown but no wave follows, so the
    // warning must stay dark even though a cooldown is pending.
    const phase: ChaosPhase = { kind: "cooldown", selectedLevel: 0, cooldownRemaining: 15 };
    expect(chaosWaveReading(phase, 30)).toEqual({
      phase: "calm",
      index: null,
      ticksUntilNext: null,
      eventsPerTick: null,
    });
  });
});
