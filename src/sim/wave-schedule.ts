/**
 * The shared wave-schedule guard (F003 hardening). Waves must sit in
 * non-decreasing `startTick` order, and their half-open `[startTick, startTick
 * + durationTicks)` ranges must never overlap. The wave admission controller
 * (`sim/actors/admission.ts`) and the engine's `start()` seam both call this,
 * so a malformed `StartOptions.waves` throws before a run allocates, instead of
 * producing arrivals in the wrong order or double-counted ticks.
 *
 * Pure and total. Callers own each wave's own rate and bounds checks.
 */
import type { Wave } from "./scenario";

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
 * Throws unless `waves` sits in non-decreasing `startTick` order with no
 * overlapping half-open ranges. Touching boundaries (one wave's end equal to
 * the next wave's start) are allowed.
 */
export function assertWaveScheduleOrdered(waves: readonly Wave[]): void {
  assertChronological(waves);
  assertNoOverlap(waves);
}
