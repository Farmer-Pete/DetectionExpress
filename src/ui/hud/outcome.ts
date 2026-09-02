/**
 * The one-line outcome the player reads for a run: running, won, or lost with the
 * reason. Shared by the top-bar `StatusPill` and the Metrics tab's tests, so both
 * read from one source of truth for a given `status` and `failureReason`
 * (GH124-PLAN.md Checkpoint 2 — extracted out of `Hud.tsx`, which used to render
 * this text itself).
 *
 * `scheduleMode` (Checkpoint 3) only changes the RUNNING line: a steady run reads
 * "Steady" instead of "Running", so the pill tells the two arrival shapes apart.
 * A concluded run (won or failed) reads the same either way — the schedule shape
 * stopped mattering once the run is over.
 */
import type { ScheduleMode } from "../../sim/scenario";
import type { FailureReason, RunStatus } from "../../sim/snapshot";

export function outcomeText(
  status: RunStatus,
  reason: FailureReason,
  scheduleMode: ScheduleMode = "waves",
) {
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
  return scheduleMode === "steady" ? "Steady" : "Running";
}
