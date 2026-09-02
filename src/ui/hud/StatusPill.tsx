/**
 * The run-status pill (GH124-PLAN.md Checkpoint 2): the one line of outcome text
 * that used to sit at the end of the HUD strip, now living in the top bar so it
 * stays visible once the four gauges move into the Metrics side-panel tab. Reads
 * `status`/`failureReason`/`scheduleMode` itself, the same live selectors `Hud`
 * used to own, and renders the shared `outcomeText()` so the two never drift
 * apart. `scheduleMode` (Checkpoint 3) reads "Steady" while a steady run is live
 * instead of "Running", so the pill still tells the player which arrival shape
 * they are watching.
 */
import { useGameStore } from "../../game/store";
import { outcomeText } from "./outcome";

export function StatusPill() {
  const status = useGameStore((state) => state.snapshot.status);
  const failureReason = useGameStore((state) => state.snapshot.failureReason);
  const scheduleMode = useGameStore((state) => state.snapshot.scheduleMode);
  return (
    <div className={`status-pill status-pill-${status}`} role="status">
      {outcomeText(status, failureReason, scheduleMode)}
    </div>
  );
}
