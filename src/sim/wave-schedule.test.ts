import { describe, expect, it } from "vitest";
import { CLOCK_HZ, PUBLISH_HZ, WAVE_RATES } from "../game/tuning";
import type { Wave } from "./scenario";
import { buildSchedule } from "./schedule";
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

describe("assertWaveScheduleOrdered: mode-gated successor gap (GH124-PLAN.md Checkpoint 3)", () => {
  const touching: Wave[] = [
    { startTick: 0, durationTicks: 10, eventsPerTick: 5 },
    { startTick: 10, durationTicks: 5, eventsPerTick: 5 }, // gap 0
  ];

  it('rejects touching boundaries by default (mode omitted, same as "waves")', () => {
    expect(() => assertWaveScheduleOrdered(touching)).toThrow();
  });

  it('rejects touching boundaries when mode is explicitly "waves"', () => {
    expect(() => assertWaveScheduleOrdered(touching, "waves")).toThrow();
  });

  it('accepts touching, gap-0 boundaries when mode is "steady"', () => {
    expect(() => assertWaveScheduleOrdered(touching, "steady")).not.toThrow();
  });

  it('still rejects chronological, overlap, and field violations in "steady" mode', () => {
    const outOfOrder: Wave[] = [
      { startTick: 20, durationTicks: 5, eventsPerTick: 1 },
      { startTick: 0, durationTicks: 5, eventsPerTick: 1 },
    ];
    expect(() => assertWaveScheduleOrdered(outOfOrder, "steady")).toThrow();

    const overlapping: Wave[] = [
      { startTick: 0, durationTicks: 10, eventsPerTick: 1 },
      { startTick: 5, durationTicks: 10, eventsPerTick: 1 },
    ];
    expect(() => assertWaveScheduleOrdered(overlapping, "steady")).toThrow();

    const badField: Wave[] = [{ startTick: -1, durationTicks: 5, eventsPerTick: 1 }];
    expect(() => assertWaveScheduleOrdered(badField, "steady")).toThrow();
  });
});

describe('assertWaveScheduleOrdered: "steady" mode rejects a fractional eventsPerTick (CodeRabbit #2)', () => {
  it("rejects contiguous steady waves at a fractional rate, since the per-wave accumulator reset would break the gapless stream", () => {
    // Two contiguous 3-tick waves at 0.5/tick would admit ticks [1, 4] instead
    // of the seamless [1, 3, 5]: exactly the seam this guard exists to forbid.
    const fractional: Wave[] = [
      { startTick: 0, durationTicks: 3, eventsPerTick: 0.5 },
      { startTick: 3, durationTicks: 3, eventsPerTick: 0.5 },
    ];
    expect(() => assertWaveScheduleOrdered(fractional, "steady")).toThrow();
  });

  it('accepts a fractional eventsPerTick in "waves" mode, where per-wave rates are not required to be contiguous or equal', () => {
    const fractional: Wave[] = [{ startTick: 0, durationTicks: 5, eventsPerTick: 0.7 }];
    expect(() => assertWaveScheduleOrdered(fractional, "waves")).not.toThrow();
  });

  it("accepts the real steady schedule's integer rate (WAVE_RATES[0])", () => {
    const rate = WAVE_RATES[0];
    if (rate === undefined) throw new Error("WAVE_RATES must carry at least one rate");
    expect(Number.isInteger(rate)).toBe(true); // the shipped steady schedule relies on this
    const waves: Wave[] = [
      { startTick: 0, durationTicks: 5, eventsPerTick: rate },
      { startTick: 5, durationTicks: 5, eventsPerTick: rate },
    ];
    expect(() => assertWaveScheduleOrdered(waves, "steady")).not.toThrow();
  });
});

describe('assertWaveScheduleOrdered: "steady" mode rejects a gapped or mixed-rate schedule (CodeRabbit #3)', () => {
  it("rejects a steady schedule with a gap between waves, even though each wave's own fields and rate are fine", () => {
    // Isolated per-wave checks (integer rate) can't catch this: nothing about
    // either wave alone is wrong, only their spacing. See
    // assertSteadyContiguousEqualRate in wave-schedule.ts.
    const gapped: Wave[] = [
      { startTick: 0, durationTicks: 5, eventsPerTick: 2 },
      { startTick: 6, durationTicks: 5, eventsPerTick: 2 }, // gap 1, not contiguous
    ];
    expect(() => assertWaveScheduleOrdered(gapped, "steady")).toThrow();
  });

  it("rejects a steady schedule where waves are contiguous but at different integer rates", () => {
    const mixedRate: Wave[] = [
      { startTick: 0, durationTicks: 5, eventsPerTick: 2 },
      { startTick: 5, durationTicks: 5, eventsPerTick: 3 }, // contiguous, but not equal-rate
    ];
    expect(() => assertWaveScheduleOrdered(mixedRate, "steady")).toThrow();
  });

  it("accepts a hand-built contiguous, equal-rate, integer-rate steady schedule", () => {
    const clean: Wave[] = [
      { startTick: 0, durationTicks: 5, eventsPerTick: 4 },
      { startTick: 5, durationTicks: 5, eventsPerTick: 4 },
      { startTick: 10, durationTicks: 5, eventsPerTick: 4 },
    ];
    expect(() => assertWaveScheduleOrdered(clean, "steady")).not.toThrow();
  });

  it("accepts the real shipped steady schedule from buildSchedule('steady')", () => {
    const { waves } = buildSchedule("steady");
    expect(() => assertWaveScheduleOrdered(waves, "steady")).not.toThrow();
  });
});
