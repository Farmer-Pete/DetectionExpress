import type { AlertReason } from "./finding";

/**
 * Attack: a real intrusion hidden in the stream (see `CONTEXT.md`). This slice's
 * Attack is a burst of wrong PINs on one account inside a time span. It is
 * Ground truth: it lives only in the scorer, never on any Event the Rule sees.
 */
export interface Attack {
  id: number;
  /** The subject this Attack is on: an account here, generic to the scorer. */
  entity: string;
  /** The pattern that reveals it; "pin_brute_force" this slice. */
  reason: AlertReason;
  /** Game seconds. The burst spans this window; evidence past endTs is too late. */
  window: { startTs: number; endTs: number };
  /** The burst's failure Event ids: at least the threshold within the window. */
  eventIds: number[];
  /**
   * Distinct cited ids an Alert must share with this Attack to credit it. Mixed
   * hunts carry different thresholds, so each Attack owns its own (GH42-PLAN.md
   * "Scoring for mixed hunts"). Required: a scenario that constructs an Attack
   * with no threshold is a generation bug, not a valid Attack, so every
   * constructor sets it explicitly rather than leaning on a silent scorer-side
   * default (see `assertValidThreshold`, called at both the generation seam,
   * `attackFromPlan`, and the scorer seam, `createScorer`).
   */
  threshold: number;
}

/**
 * Validate an Attack's threshold is a positive integer, naming the failure mode
 * rather than letting a zero, negative, or fractional value silently reach the
 * scorer and produce a nonsensical credit rule (a threshold of 0 would credit
 * every Alert regardless of evidence; a negative one is nonsensical outright).
 */
export function assertValidThreshold(attack: Pick<Attack, "id" | "threshold">): void {
  if (!Number.isInteger(attack.threshold) || attack.threshold <= 0) {
    throw new Error(
      `Attack ${attack.id}'s threshold must be a positive integer, got ${attack.threshold}.`,
    );
  }
}
