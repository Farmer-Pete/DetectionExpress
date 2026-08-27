/**
 * Scenario: one playable level (see `CONTEXT.md`). It composes Endpoints, drives
 * the intent timeline, injects Attacks, and records the Ground truth. It is pure:
 * `generate(seed)` returns the sorted Events and the Attacks behind them, and the
 * same seed always returns the same run.
 */
import type { Attack } from "./attack";
import type { PipeEvent } from "./event";

/** A generated run: the sorted stream and the Ground truth behind it. */
export interface GeneratedRun {
  /** Events sorted by scheduled time, with engine ids already assigned. */
  events: PipeEvent[];
  /** The Attacks hidden in the stream. Only the scorer sees these. */
  attacks: Attack[];
}

export interface Scenario {
  readonly id: string;
  /** The Hunt text shown to the player before they touch the Rule. */
  readonly briefing: string;
  /** Plan the whole run from a seed. Deterministic. */
  generate(seed: number): GeneratedRun;
}
