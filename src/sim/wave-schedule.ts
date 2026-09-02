/**
 * The shared wave-schedule guard (F003 hardening, F002 field validation). Every
 * wave's own fields must be well-formed, waves must sit in non-decreasing
 * `startTick` order, and their half-open `[startTick, startTick +
 * durationTicks)` ranges must never overlap. In `"waves"` mode each successor
 * must also leave a drain gap wide enough for its own `incoming` cue to
 * publish; `"steady"` mode (GH124-PLAN.md Checkpoint 3) skips that one check,
 * since a gapless constant stream is intentional there, and instead requires
 * every `eventsPerTick` to be an integer, so the accumulator reset at each
 * contiguous wave's start (`sim/actors/admission.ts`) never leaves a seam. The
 * wave admission controller (`sim/actors/admission.ts`) and the engine's
 * `start()` seam both call this with the same mode, so a malformed
 * `StartOptions.waves` throws before a run allocates, instead of producing
 * arrivals in the wrong order, double-counted ticks, a stalled accumulator, or
 * a successor whose arrival cue never shows.
 *
 * Pure and total. `assertWaveScheduleOrdered` covers all of the above in one
 * call; the only thing left to a caller is any accumulator-specific cap on
 * `eventsPerTick` it needs on top (see `sim/actors/admission.ts`'s
 * `MAX_EVENTS_PER_TICK`).
 */
import { CLOCK_HZ, PUBLISH_HZ } from "../game/tuning";
import type { ScheduleMode, Wave } from "./scenario";

/**
 * The smallest tick gap a successor wave needs after the prior wave ends for its
 * `incoming` cue to publish at all. In `waveStateAt` the `active` phase outranks
 * the next wave's warn window, so a successor's `incoming` reading only exists at
 * ticks strictly after the prior wave's end; the sampler catches one of those
 * only if that drain window is at least the publish stride (`CLOCK_HZ /
 * PUBLISH_HZ`) ticks wide. See `wave-state.ts` and the `DRAIN_GAP_TICKS` note in
 * `tuning.ts`, which the real schedule already honors.
 */
const MIN_SUCCESSOR_GAP_TICKS = CLOCK_HZ / PUBLISH_HZ;

/**
 * Reject a wave whose own fields are malformed, independent of its position in
 * the schedule: `startTick` must be a non-negative safe integer, `durationTicks`
 * must be a positive safe integer (a wave that emits zero ticks is not a wave),
 * and their sum must not exceed `Number.MAX_SAFE_INTEGER`, so every emitted
 * tick stays whole and in range for exact arithmetic. `eventsPerTick` must be
 * a finite, non-negative number, so a per-tick accumulator can never stall or
 * loop forever. Carries no cap on `eventsPerTick`: an accumulator-specific
 * ceiling (like admission's `MAX_EVENTS_PER_TICK`) is a caller's own concern,
 * not a schedule-shape one.
 */
export function assertWaveFields(wave: Wave, index: number): void {
  if (!Number.isSafeInteger(wave.startTick) || wave.startTick < 0) {
    throw new Error(
      `assertWaveFields: wave ${index} startTick must be a non-negative safe integer.`,
    );
  }
  if (!Number.isSafeInteger(wave.durationTicks) || wave.durationTicks < 1) {
    throw new Error(
      `assertWaveFields: wave ${index} durationTicks must be a positive safe integer.`,
    );
  }
  if (wave.startTick + wave.durationTicks > Number.MAX_SAFE_INTEGER) {
    throw new Error(
      `assertWaveFields: wave ${index} startTick + durationTicks must not exceed Number.MAX_SAFE_INTEGER.`,
    );
  }
  if (!Number.isFinite(wave.eventsPerTick) || wave.eventsPerTick < 0) {
    throw new Error(
      `assertWaveFields: wave ${index} eventsPerTick must be a finite, non-negative number.`,
    );
  }
}

/**
 * Reject waves that are not in non-decreasing `startTick` order. Together with
 * the no-overlap check this makes any downstream tick scan come out sorted,
 * since each wave's ticks then all precede the next wave's. Callers build
 * waves left to right.
 */
function assertChronological(waves: readonly Wave[]): void {
  for (let i = 1; i < waves.length; i++) {
    const prev = waves[i - 1];
    const cur = waves[i];
    if (prev === undefined || cur === undefined) {
      continue;
    }
    if (cur.startTick < prev.startTick) {
      throw new Error(`assertWaveScheduleOrdered: wave ${i} starts before wave ${i - 1}.`);
    }
  }
}

/** Reject any pair of waves whose half-open tick ranges overlap, regardless of input order. */
function assertNoOverlap(waves: readonly Wave[]): void {
  for (let i = 0; i < waves.length; i++) {
    const a = waves[i];
    if (a === undefined) {
      continue;
    }
    const aEnd = a.startTick + a.durationTicks;
    for (let j = i + 1; j < waves.length; j++) {
      const b = waves[j];
      if (b === undefined) {
        continue;
      }
      const bEnd = b.startTick + b.durationTicks;
      const disjoint = aEnd <= b.startTick || bEnd <= a.startTick;
      if (!disjoint) {
        throw new Error(`assertWaveScheduleOrdered: wave ${i} and wave ${j} overlap.`);
      }
    }
  }
}

/**
 * Reject a successor wave that crowds the wave before it. Because `active`
 * outranks `incoming` in `waveStateAt`, a successor's `incoming` phase can only
 * occupy ticks that sit strictly after the prior wave's end, so it needs a drain
 * gap of at least `MIN_SUCCESSOR_GAP_TICKS` for the sampler to catch even one
 * `incoming` tick and fire the arrival cue. Touching (gap 0) or barely-separated
 * waves would publish no `incoming` reading for the successor at all. Waves are
 * non-decreasing and non-overlapping by the time this runs, so consecutive
 * entries are the adjacent pair and `cur.startTick - prevEnd` is their gap,
 * never negative.
 */
function assertSuccessorGap(waves: readonly Wave[]): void {
  for (let i = 1; i < waves.length; i++) {
    const prev = waves[i - 1];
    const cur = waves[i];
    if (prev === undefined || cur === undefined) {
      continue;
    }
    const gap = cur.startTick - (prev.startTick + prev.durationTicks);
    if (gap < MIN_SUCCESSOR_GAP_TICKS) {
      throw new Error(
        `assertWaveScheduleOrdered: wave ${i} starts ${gap} tick(s) after wave ${i - 1} ends; a successor needs at least ${MIN_SUCCESSOR_GAP_TICKS} (CLOCK_HZ / PUBLISH_HZ) to publish its incoming cue.`,
      );
    }
  }
}

/**
 * Reject a non-integer `eventsPerTick` in `"steady"` mode. A steady schedule's
 * waves are contiguous (gap 0) and equal-rate, and `admitArrivals` resets its
 * fractional accumulator at each wave's start (`sim/actors/admission.ts`); only
 * a whole rate is guaranteed to land the accumulator back on exactly zero by a
 * wave's end. A fractional rate would leave a nonzero carry that the reset
 * silently drops, breaking the seam-free stream contiguous steady waves exist
 * to guarantee (e.g. two contiguous 3-tick waves at 0.5/tick would admit
 * ticks `[1, 4]` instead of the seamless `[1, 3, 5]`). The shipped steady
 * schedule already uses the integer `WAVE_RATES[0]`, so this rejects a shape
 * no live caller builds; it exists so that guarantee holds by construction
 * instead of by convention.
 */
function assertSteadyIntegerRate(waves: readonly Wave[]): void {
  waves.forEach((wave, index) => {
    if (!Number.isInteger(wave.eventsPerTick)) {
      throw new Error(
        `assertWaveScheduleOrdered: wave ${index} eventsPerTick ${wave.eventsPerTick} must be an integer in "steady" mode, so the per-wave accumulator reset produces no seam between contiguous waves.`,
      );
    }
  });
}

/**
 * Throws unless every wave's own fields are well-formed (`assertWaveFields`)
 * AND `waves` sits in non-decreasing `startTick` order with no overlapping
 * half-open ranges AND, in `"waves"` mode, each successor sits at least
 * `MIN_SUCCESSOR_GAP_TICKS` past the prior wave's end AND, in `"steady"` mode,
 * every `eventsPerTick` is an integer. One call covers all of those checks, so
 * a caller needs no separate field pass of its own. Touching boundaries (one
 * wave's end equal to the next wave's start) are rejected in `"waves"` mode: a
 * successor with too small a drain gap never publishes its `incoming` cue (see
 * `assertSuccessorGap`).
 *
 * `mode` defaults to `"waves"`, the original ramp. In `"steady"` mode
 * (GH124-PLAN.md Checkpoint 3) `assertSuccessorGap` is skipped: touching,
 * gap-0 waves are the intended shape of a contiguous constant stream, and the
 * `incoming` cue the gap exists for is never sampled while steady (the sampler
 * always publishes `calm`). In its place, `"steady"` mode runs
 * `assertSteadyIntegerRate`: a fractional rate would break the seam-free
 * guarantee contiguous waves are meant to provide (see that function's
 * docstring), so it is rejected here rather than left as a latent trap. Every
 * OTHER check still runs in steady mode — fields, order, and no-overlap are
 * unconditional regardless of arrival shape.
 */
export function assertWaveScheduleOrdered(
  waves: readonly Wave[],
  mode: ScheduleMode = "waves",
): void {
  waves.forEach((wave, index) => {
    assertWaveFields(wave, index);
  });
  assertChronological(waves);
  assertNoOverlap(waves);
  if (mode === "steady") {
    assertSteadyIntegerRate(waves);
  } else {
    assertSuccessorGap(waves);
  }
}
