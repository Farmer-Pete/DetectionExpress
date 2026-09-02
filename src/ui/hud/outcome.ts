/**
 * The one-line outcome the player reads for a run: running, won, or lost with the
 * reason. Shared by the top-bar `StatusPill` and the Metrics tab's tests, so both
 * read from one source of truth for a given `status` and `failureReason`
 * (GH124-PLAN.md Checkpoint 2 — extracted out of `Hud.tsx`, which used to render
 * this text itself).
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
