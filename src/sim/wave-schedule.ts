/**
 * The shared wave-schedule guard (F003 hardening, F002 field validation). Every
 * wave's own fields must be well-formed, waves must sit in non-decreasing
 * `startTick` order, and their half-open `[startTick, startTick +
 * durationTicks)` ranges must never overlap. The wave admission controller
 * (`sim/actors/admission.ts`) and the engine's `start()` seam both call this,
 * so a malformed `StartOptions.waves` throws before a run allocates, instead of
 * producing arrivals in the wrong order, double-counted ticks, or a stalled
 * accumulator.
 *
 * Pure and total. `assertWaveScheduleOrdered` covers all three checks (fields,
 * order, overlap) in one call; the only thing left to a caller is any
 * accumulator-specific cap on `eventsPerTick` it needs on top (see
 * `sim/actors/admission.ts`'s `MAX_EVENTS_PER_TICK`).
 */
import type { Wave } from "./scenario";

/**
 * Reject a wave whose own fields are malformed, independent of its position in
 * the schedule: `startTick` and `durationTicks` must be non-negative integers,
 * so every emitted tick stays whole, and `eventsPerTick` must be a finite,
 * non-negative number, so a per-tick accumulator can never stall or loop
 * forever. Carries no cap on `eventsPerTick`: an accumulator-specific ceiling
 * (like admission's `MAX_EVENTS_PER_TICK`) is a caller's own concern, not a
 * schedule-shape one.
 */
export function assertWaveFields(wave: Wave, index: number): void {
  if (!Number.isInteger(wave.startTick) || wave.startTick < 0) {
    throw new Error(
      `assertWaveScheduleOrdered: wave ${index} startTick must be a non-negative integer.`,
    );
  }
  if (!Number.isInteger(wave.durationTicks) || wave.durationTicks < 0) {
    throw new Error(
      `assertWaveScheduleOrdered: wave ${index} durationTicks must be a non-negative integer.`,
    );
  }
  if (!Number.isFinite(wave.eventsPerTick) || wave.eventsPerTick < 0) {
    throw new Error(
      `assertWaveScheduleOrdered: wave ${index} eventsPerTick must be a finite, non-negative number.`,
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
 * Throws unless every wave's own fields are well-formed (`assertWaveFields`)
 * AND `waves` sits in non-decreasing `startTick` order with no overlapping
 * half-open ranges. One call covers all three checks, so a caller needs no
 * separate field pass of its own. Touching boundaries (one wave's end equal to
 * the next wave's start) are allowed.
 */
export function assertWaveScheduleOrdered(waves: readonly Wave[]): void {
  waves.forEach((wave, index) => {
    assertWaveFields(wave, index);
  });
  assertChronological(waves);
  assertNoOverlap(waves);
}
