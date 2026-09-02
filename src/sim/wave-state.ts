/**
 * The wave reading: derives where a tick sits relative to the schedule's waves,
 * so the sampler can publish it in the snapshot and the UI can show it without
 * ever deriving sim truth itself (GH38+40-PLAN.md Part 1, decision 2). Pure and
 * total: no wall-clock, no DOM.
 */
import type { Wave } from "./scenario";
import type { ChaosPhase } from "./snapshot";

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
 * the two waves to have any ticks to occupy at all. And because `active`
 * outranks `incoming`, that window can never spill backward into the prior
 * wave even when `WAVE_WARN_TICKS` would otherwise open it earlier: the
 * observable window is exactly `min(WAVE_WARN_TICKS, DRAIN_GAP_TICKS)` ticks
 * wide. For the sampler to actually catch one of those ticks, that width must
 * be at least the publish stride (`CLOCK_HZ / PUBLISH_HZ`), the invariant
 * `DRAIN_GAP_TICKS` and `WAVE_WARN_TICKS` document and `schedule.test.ts`
 * locks (F012, F023).
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

/**
 * The wave reading derived from the repeating chaos loop's phase, for endless mode
 * (GH126-PLAN.md M3b, Q7). The endless run carries no static `waves` schedule, so the
 * sampler bridges the chaos loop into the SAME `WaveReading` the `waves`-mode sampler
 * publishes. This lights the existing `LogPanel` readout, `.waveflash`, App `.shake`,
 * and the screen-reader "wave incoming"/"wave arrived" announcements for chaos waves
 * with no UI rewrite. Pure and total, like `waveStateAt`, so it is unit-testable
 * without the engine.
 *
 * The chaos loop is COOLDOWN-FIRST: a lead-in cooldown precedes every wave. So:
 * - a wave in flight reads `active` (nominal `index` 0, no `eventsPerTick` — a chaos
 *   wave carries no single benign baseline rate);
 * - a lead-in cooldown with a wave truly coming (`selectedLevel > 0`) reads `calm`
 *   ("next wave in Ns") until `cooldownRemaining` falls within `warnTicks`, then
 *   `incoming` ("WAVE INCOMING"), mirroring `waveStateAt`'s pre-wave shape;
 * - anything else — idle, or the final cooldown of a level-0 stop where no wave
 *   follows — reads `calm` with a null index, so the warning stays dark.
 */
export function chaosWaveReading(phase: ChaosPhase, warnTicks: number): WaveReading {
  if (phase.kind === "wave") {
    return { phase: "active", index: 0, ticksUntilNext: null, eventsPerTick: null };
  }
  if (phase.kind === "cooldown" && phase.selectedLevel > 0) {
    const ticksUntilNext = phase.cooldownRemaining ?? 0;
    const wavePhase: WavePhase = ticksUntilNext <= warnTicks ? "incoming" : "calm";
    return { phase: wavePhase, index: 0, ticksUntilNext, eventsPerTick: null };
  }
  return { phase: "calm", index: null, ticksUntilNext: null, eventsPerTick: null };
}
