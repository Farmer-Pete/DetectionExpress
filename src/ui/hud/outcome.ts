/**
 * The one-line outcome text for a run: running, won, or lost with the reason. A pure
 * mapper from `status` + `failureReason` to text, with its own co-located tests. No UI
 * renders it today (the top-bar run-status badge was removed in GH132); it is kept as the
 * one source of run-outcome text for when run status is surfaced again (GH124-PLAN.md
 * Checkpoint 2).
 */
import type { FailureReason, RunStatus } from "../../sim/snapshot";

export function outcomeText(status: RunStatus, reason: FailureReason) {
  if (status === "won") {
    return "Won";
  }
  if (status === "failed") {
    return reason === "queue"
      ? "Failed: Queue overflowed"
      : reason === "correctness"
        ? "Failed: Correctness too low"
        : "Failed";
  }
  return "Running";
}
