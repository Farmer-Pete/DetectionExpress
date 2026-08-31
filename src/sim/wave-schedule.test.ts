import { describe, expect, it } from "vitest";
import { CLOCK_HZ, PUBLISH_HZ } from "../game/tuning";
import type { Wave } from "./scenario";
import { assertWaveFields, assertWaveScheduleOrdered } from "./wave-schedule";

/** The minimum successor drain gap the guard enforces (see `wave-schedule.ts`). */
const MIN_SUCCESSOR_GAP_TICKS = CLOCK_HZ / PUBLISH_HZ;

describe("assertWaveFields (F002)", () => {
  it("accepts a well-formed wave", () => {
    expect(() =>
      assertWaveFields({ startTick: 0, durationTicks: 10, eventsPerTick: 1.5 }, 0),
    ).not.toThrow();
  });

  it("rejects a NaN startTick", () => {
    expect(() =>
      assertWaveFields({ startTick: Number.NaN, durationTicks: 5, eventsPerTick: 1 }, 0),
    ).toThrow();
  });

  it("rejects a negative startTick", () => {
    expect(() =>
      assertWaveFields({ startTick: -1, durationTicks: 5, eventsPerTick: 1 }, 0),
    ).toThrow();
  });

  it("rejects a negative durationTicks", () => {
    expect(() =>
      assertWaveFields({ startTick: 0, durationTicks: -5, eventsPerTick: 1 }, 0),
    ).toThrow();
  });

  it("rejects a zero durationTicks (F023: a wave must emit at least one tick)", () => {
    expect(() =>
      assertWaveFields({ startTick: 0, durationTicks: 0, eventsPerTick: 1 }, 0),
    ).toThrow();
  });

  it("rejects a non-integer durationTicks", () => {
    expect(() =>
      assertWaveFields({ startTick: 0, durationTicks: 5.5, eventsPerTick: 1 }, 0),
    ).toThrow();
  });

  it("rejects an infinite eventsPerTick", () => {
    expect(() =>
      assertWaveFields(
        { startTick: 0, durationTicks: 5, eventsPerTick: Number.POSITIVE_INFINITY },
        0,
      ),
    ).toThrow();
  });

  it("rejects a negative eventsPerTick", () => {
    expect(() =>
      assertWaveFields({ startTick: 0, durationTicks: 5, eventsPerTick: -1 }, 0),
    ).toThrow();
  });

  it("carries no MAX_EVENTS_PER_TICK cap: a very large finite rate is fine here", () => {
    // The accumulator-specific cap is admission.ts's own concern (F002), not this
    // shared field check's.
    expect(() =>
      assertWaveFields({ startTick: 0, durationTicks: 5, eventsPerTick: 1_000_000 }, 0),
    ).not.toThrow();
  });

  it("rejects a startTick at 2**53 (past Number.MAX_SAFE_INTEGER)", () => {
    expect(() =>
      assertWaveFields({ startTick: 2 ** 53, durationTicks: 5, eventsPerTick: 1 }, 0),
    ).toThrow();
  });

  it("rejects a durationTicks at 2**53 (past Number.MAX_SAFE_INTEGER)", () => {
    expect(() =>
      assertWaveFields({ startTick: 0, durationTicks: 2 ** 53, eventsPerTick: 1 }, 0),
    ).toThrow();
  });

  it("rejects a startTick/durationTicks pair whose sum overflows MAX_SAFE_INTEGER, even though each part is safe on its own", () => {
    expect(() =>
      assertWaveFields(
        { startTick: Number.MAX_SAFE_INTEGER - 1, durationTicks: 2, eventsPerTick: 1 },
        0,
      ),
    ).toThrow();
  });

  it("accepts a startTick/durationTicks pair that is large but stays within MAX_SAFE_INTEGER", () => {
    expect(() =>
      assertWaveFields(
        { startTick: Number.MAX_SAFE_INTEGER - 10, durationTicks: 5, eventsPerTick: 1 },
        0,
      ),
    ).not.toThrow();
  });
});

describe("assertWaveScheduleOrdered", () => {
  it("accepts an empty schedule", () => {
    expect(() => assertWaveScheduleOrdered([])).not.toThrow();
  });

  it("accepts waves in ascending startTick order", () => {
    const waves: Wave[] = [
      { startTick: 0, durationTicks: 5, eventsPerTick: 1 },
      { startTick: 10, durationTicks: 5, eventsPerTick: 2 },
      { startTick: 20, durationTicks: 5, eventsPerTick: 3 },
    ];
    expect(() => assertWaveScheduleOrdered(waves)).not.toThrow();
  });

  it("rejects touching boundaries, where one wave's end equals the next wave's start", () => {
    // Gap 0: wave 1 would never publish an `incoming` reading, so its arrival
    // cue could never fire (F014). See `assertSuccessorGap` in `wave-schedule.ts`.
    const waves: Wave[] = [
      { startTick: 0, durationTicks: 10, eventsPerTick: 1 },
      { startTick: 10, durationTicks: 5, eventsPerTick: 2 },
    ];
    expect(() => assertWaveScheduleOrdered(waves)).toThrow();
  });

  it("accepts a successor exactly the minimum drain gap past the prior wave", () => {
    const waves: Wave[] = [
      { startTick: 0, durationTicks: 10, eventsPerTick: 1 },
      { startTick: 10 + MIN_SUCCESSOR_GAP_TICKS, durationTicks: 5, eventsPerTick: 2 },
    ];
    expect(() => assertWaveScheduleOrdered(waves)).not.toThrow();
  });

  it("rejects a successor gap one tick under the minimum", () => {
    const waves: Wave[] = [
      { startTick: 0, durationTicks: 10, eventsPerTick: 1 },
      { startTick: 10 + MIN_SUCCESSOR_GAP_TICKS - 1, durationTicks: 5, eventsPerTick: 2 },
    ];
    expect(() => assertWaveScheduleOrdered(waves)).toThrow();
  });

  it("rejects waves given out of chronological order", () => {
    const waves: Wave[] = [
      { startTick: 20, durationTicks: 5, eventsPerTick: 1 },
      { startTick: 0, durationTicks: 5, eventsPerTick: 1 },
    ];
    expect(() => assertWaveScheduleOrdered(waves)).toThrow();
  });

  it("rejects two waves that overlap", () => {
    const waves: Wave[] = [
      { startTick: 0, durationTicks: 10, eventsPerTick: 1 },
      { startTick: 5, durationTicks: 10, eventsPerTick: 1 },
    ];
    expect(() => assertWaveScheduleOrdered(waves)).toThrow();
  });

  it("rejects overlapping waves given out of order", () => {
    const waves: Wave[] = [
      { startTick: 5, durationTicks: 10, eventsPerTick: 1 },
      { startTick: 0, durationTicks: 10, eventsPerTick: 1 },
    ];
    expect(() => assertWaveScheduleOrdered(waves)).toThrow();
  });

  it("rejects a NaN startTick (F002)", () => {
    const waves: Wave[] = [{ startTick: Number.NaN, durationTicks: 5, eventsPerTick: 1 }];
    expect(() => assertWaveScheduleOrdered(waves)).toThrow();
  });

  it("rejects a negative startTick (F002)", () => {
    const waves: Wave[] = [{ startTick: -1, durationTicks: 5, eventsPerTick: 1 }];
    expect(() => assertWaveScheduleOrdered(waves)).toThrow();
  });

  it("rejects a negative durationTicks (F002)", () => {
    const waves: Wave[] = [{ startTick: 0, durationTicks: -5, eventsPerTick: 1 }];
    expect(() => assertWaveScheduleOrdered(waves)).toThrow();
  });

  it("rejects a non-integer durationTicks (F002)", () => {
    const waves: Wave[] = [{ startTick: 0, durationTicks: 5.5, eventsPerTick: 1 }];
    expect(() => assertWaveScheduleOrdered(waves)).toThrow();
  });

  it("rejects an infinite eventsPerTick (F002)", () => {
    const waves: Wave[] = [
      { startTick: 0, durationTicks: 5, eventsPerTick: Number.POSITIVE_INFINITY },
    ];
    expect(() => assertWaveScheduleOrdered(waves)).toThrow();
  });

  it("rejects a negative eventsPerTick (F002)", () => {
    const waves: Wave[] = [{ startTick: 0, durationTicks: 5, eventsPerTick: -1 }];
    expect(() => assertWaveScheduleOrdered(waves)).toThrow();
  });

  it("accepts a well-formed wave, fields, order, overlap, and successor gap all clean (F002)", () => {
    const waves: Wave[] = [
      { startTick: 0, durationTicks: 10, eventsPerTick: 1.5 },
      { startTick: 10 + MIN_SUCCESSOR_GAP_TICKS, durationTicks: 5, eventsPerTick: 2 },
    ];
    expect(() => assertWaveScheduleOrdered(waves)).not.toThrow();
  });
});
