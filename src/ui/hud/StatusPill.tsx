/**
 * The run-status pill (GH124-PLAN.md Checkpoint 2): the one line of outcome text
 * that used to sit at the end of the HUD strip, now living in the top bar so it
 * stays visible once the four gauges move into the Metrics side-panel tab. Reads
 * `status`/`failureReason` itself, the same live selectors `Hud` used to own, and
 * renders the shared `outcomeText()` so the two never drift apart.
 */
import { useGameStore } from "../../game/store";
import { outcomeText } from "./outcome";

export function StatusPill() {
  const status = useGameStore((state) => state.snapshot.status);
  const failureReason = useGameStore((state) => state.snapshot.failureReason);
  return (
    <div className={`status-pill status-pill-${status}`} role="status">
      {outcomeText(status, failureReason)}
    </div>
  );
}
