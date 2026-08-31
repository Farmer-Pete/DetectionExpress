/**
 * The wave reading: derives where a tick sits relative to the schedule's waves,
 * so the sampler can publish it in the snapshot and the UI can show it without
 * ever deriving sim truth itself (GH38+40-PLAN.md Part 1, decision 2). Pure and
 * total: no wall-clock, no DOM.
 */
import type { Wave } from "./scenario";

/** Where a tick sits relative to the wave schedule. */
export type WavePhase = "calm" | "incoming" | "active";

export interface WaveReading {
  phase: WavePhase;
  /** Zero-based index of the active wave, or of the next wave while calm/incoming. Null after the last wave ends. */
  index: number | null;
  /** Ticks until the next wave starts. Null while active or after the last wave. */
  ticksUntilNext: number | null;
  /** Events per tick of the active wave; null otherwise. */
  eventsPerTick: number | null;
}

/**
 * Read the wave state at `tick`. Waves are half-open (`[startTick, startTick +
 * durationTicks)`), sorted, and never overlap (see `Wave` in `scenario.ts`); a
 * linear scan over the handful of waves a run schedules is negligible.
 *
 * Precedence is `active > incoming > calm`: a tick inside one wave, while the
 * next wave's warn window has already opened, reads `active`. Both
 * `WAVE_WARN_TICKS` and the drain pacing are tuning knobs, so that overlap is
 * reachable and must resolve predictably. A consequence of that precedence: a
 * successor wave's `incoming` phase is only ever observable at a tick that sits
 * strictly after the prior wave's end, so it needs a positive drain gap between
 * the two waves to have any ticks to occupy at all — and, for the sampler to
 * actually catch one of those ticks, that gap must be at least the publish
 * stride (`CLOCK_HZ / PUBLISH_HZ`), the invariant `DRAIN_GAP_TICKS` documents
 * and `schedule.test.ts` locks (F012).
 *
 * `incoming` covers the half-open warn window immediately before a wave's
 * start: `ticksUntilNext` in `(0, warnTicks]`. `eventsPerTick` on an `active`
 * reading is the wave's BENIGN baseline rate; after GH102, attack fails and
 * fumbles ride on top of it, so it is not the true total and the UI must never
 * present it as one.
 */
export function waveStateAt(tick: number, waves: readonly Wave[], warnTicks: number): WaveReading {
  for (let i = 0; i < waves.length; i++) {
    const wave = waves[i];
    if (wave && tick >= wave.startTick && tick < wave.startTick + wave.durationTicks) {
      return { phase: "active", index: i, ticksUntilNext: null, eventsPerTick: wave.eventsPerTick };
    }
  }
  for (let i = 0; i < waves.length; i++) {
    const wave = waves[i];
    if (wave && wave.startTick > tick) {
      const ticksUntilNext = wave.startTick - tick;
      const phase: WavePhase = ticksUntilNext <= warnTicks ? "incoming" : "calm";
      return { phase, index: i, ticksUntilNext, eventsPerTick: null };
    }
  }
  // No active wave and no wave still to come: either `waves` is empty, or every
  // wave has already ended.
  return { phase: "calm", index: null, ticksUntilNext: null, eventsPerTick: null };
}
