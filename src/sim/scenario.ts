/**
 * Scenario: one playable level (see `CONTEXT.md`). It composes Endpoints, drives
 * the intent timeline, injects Attacks, and records the Ground truth. It is pure:
 * `generate(seed)` returns the sorted Events and the Attacks behind them, and the
 * same seed always returns the same run.
 */
import type { Attack } from "./attack";
import type { PipeEvent } from "./event";

/**
 * How the run's benign arrival stream is shaped (GH124-PLAN.md Checkpoint 3).
 * `"waves"` is the original ramp: `WAVE_RATES` climbing wave over wave, each
 * pair separated by a drain gap wide enough for the successor's `incoming` cue.
 * `"steady"` swaps that ramp for one gapless constant stream at the calm
 * baseline rate, with no incoming cue and no interim checkpoints. Both still
 * carry exactly `WAVE_COUNT` waves, since `planAttacks()` plans one attack
 * batch per wave regardless of the arrival shape underneath it.
 */
export type ScheduleMode = "waves" | "steady";

/**
 * One arrival wave: benign volume climbs per wave. Rates are Events per tick;
 * fractional emission uses a carried accumulator, not per-Event rounding. Waves
 * are half-open `[startTick, startTick + durationTicks)` and never overlap.
 */
export interface Wave {
  startTick: number;
  durationTicks: number;
  eventsPerTick: number;
}

/**
 * A run gate the engine evaluates at the start of `atTick`, before that tick's
 * task continuations resume. It clears every record already due through
 * `clearsThroughWave` (a zero-based wave index) — the events admitted and
 * completed so far, not every event a wave will ever emit, since a wave can
 * still be in flight or an event can arrive late inside a drain gap. The
 * checkpoint after the last wave is the final deadline. See GH3-PLAN.md
 * section 5.3.
 */
export interface Checkpoint {
  atTick: number;
  clearsThroughWave: number;
}

/** A generated run: the sorted stream and the Ground truth behind it. */
export interface GeneratedRun {
  /** Events sorted by scheduled time, with engine ids already assigned. */
  events: PipeEvent[];
  /** The Attacks hidden in the stream. Only the scorer sees these. */
  attacks: Attack[];
  /** The wave boundaries plus the final deadline, in tick order. */
  checkpoints: Checkpoint[];
  /**
   * The wave boundaries `checkpoints` derives from. The sim publishes this in the
   * snapshot (`waveStateAt`, `wave-state.ts`) so the UI reads the same waves the
   * generator emitted — the UI never derives sim truth (GH38+40-PLAN.md decision 2).
   */
  waves: Wave[];
}

export interface Scenario {
  readonly id: string;
  /**
   * Plan the whole run from a seed. Deterministic: the same seed (and, when
   * given, the same partition) always returns the same run.
   *
   * `partition` is the composable-streams seam (GH42-PLAN.md "the merge seam"),
   * promoted here from the scenario-specific `generate` a scenario module used to
   * expose on the side: omitted, a scenario draws its identity pool from its own
   * seeded rng, exactly as a solo run always has. Given an explicit partition, a
   * scenario that supports it draws instead from a fixed, seed-independent
   * namespace slice, so two runs generated from different seeds but different
   * partitions are guaranteed to draw disjoint entities — `mergeRuns`'s
   * entity-disjointness invariant depends on this. A scenario with nothing to
   * partition may simply ignore the argument.
   */
  generate(seed: number, partition?: number): GeneratedRun;
}
