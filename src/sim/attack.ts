import type { AlertReason } from "./finding";

/**
 * Attack: a real intrusion hidden in the stream (see `CONTEXT.md`). This slice's
 * Attack is a burst of wrong PINs on one account inside a time span. It is
 * Ground truth: it lives only in the scorer, never on any Event the Rule sees.
 */
export interface Attack {
  id: number;
  account: string;
  /** The pattern that reveals it; "pin_brute_force" this slice. */
  reason: AlertReason;
  /** Game seconds. The burst spans this window; evidence past endTs is too late. */
  window: { startTs: number; endTs: number };
  /** The burst's failure Event ids: at least the threshold within the window. */
  eventIds: number[];
}
