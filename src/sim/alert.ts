/**
 * Alert: the object the Engine raises when the Algorithm decides a pattern is an
 * Attack (see `CONTEXT.md`). It names a reason, the time the pattern crossed, and
 * the Event ids it cites. One correct Alert per Attack raises Correctness; a
 * wrong or duplicate one lowers it.
 */

/** Each Scenario names its own reasons; the scorer only matches them by value. */
export type AlertReason = string;

export interface Alert {
  reason: AlertReason;
  /** Game seconds: the point the pattern crossed. */
  at: number;
  /** Ids of the failure Events the Alert cites as evidence. */
  events: number[];
}
