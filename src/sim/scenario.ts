/**
 * Scenario: one playable level (see `CONTEXT.md`). It composes Endpoints, drives
 * the intent timeline, injects Attacks, and records the Ground truth. It is pure:
 * `generate(seed)` returns the sorted Events and the Attacks behind them, and the
 * same seed always returns the same run.
 */
import type { Attack } from "./attack";
import type { PipeEvent } from "./event";

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
 * task continuations resume. It clears every wave up to and including
 * `clearsThroughWave` (a zero-based wave index). The checkpoint after the last
 * wave is the final deadline. See GH3-PLAN.md section 5.3.
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
}

export interface Scenario {
  readonly id: string;
  /** The Hunt text shown to the player before they touch the Rule. */
  readonly briefing: string;
  /** Plan the whole run from a seed. Deterministic. */
  generate(seed: number): GeneratedRun;
}
