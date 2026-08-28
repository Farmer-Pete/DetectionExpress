/** The HUD strip. Reads live sim values through primitive selectors, one per gauge. */

import { useGameStore } from "../../game/store";
import { CHANNEL_CAP } from "../../game/tuning";
import type { FailureReason, RunStatus } from "../../sim/snapshot";
import { Gauge } from "../gauges/Gauge";

/** The effective Backlog ceiling: the two upstream channels fill; the Sink drains at once. */
const BACKLOG_MAX = 2 * CHANNEL_CAP;

/** The Backlog fill ramps healthy -> warning -> danger with occupancy. */
function backlogFill(fraction: number) {
  if (fraction >= 0.8) {
    return "var(--threat)";
  }
  if (fraction >= 0.5) {
    return "var(--alert)";
  }
  return "var(--ok)";
}

/** The Correctness fill ramps the other way: it is healthy high, danger low. */
function correctnessFill(rolling: number) {
  if (rolling >= 80) {
    return "var(--ok)";
  }
  if (rolling >= 50) {
    return "var(--alert)";
  }
  return "var(--threat)";
}

/** The one-line outcome the player reads: running, won, or lost with the reason. */
function outcomeText(status: RunStatus, reason: FailureReason) {
  if (status === "won") {
    return "Won";
  }
  if (status === "failed") {
    return reason === "backlog"
      ? "Failed: Backlog overflowed"
      : reason === "correctness"
        ? "Failed: Correctness too low"
        : "Failed";
  }
  return "Running";
}

export function Hud() {
  const throughput = useGameStore((state) => state.snapshot.throughput);
  const backlog = useGameStore((state) => state.snapshot.backlog);
  const rolling = useGameStore((state) => state.snapshot.correctness.rolling);
  const caught = useGameStore((state) => state.snapshot.correctness.caught);
  const missed = useGameStore((state) => state.snapshot.correctness.missed);
  const falseAlerts = useGameStore((state) => state.snapshot.correctness.falseAlerts);
  const status = useGameStore((state) => state.snapshot.status);
  const failureReason = useGameStore((state) => state.snapshot.failureReason);
  return (
    <div className="hud">
      <Gauge label="Throughput" value={throughput} max={20} unit="/s" fill="var(--a1)" />
      <Gauge
        label="Backlog"
        value={backlog}
        max={BACKLOG_MAX}
        unit=""
        fill={backlogFill(backlog / BACKLOG_MAX)}
      />
      <Gauge label="Correctness" value={rolling} max={100} unit="" fill={correctnessFill(rolling)}>
        <div className="gauge-counts">
          <span className="gauge-count gauge-count-ok">{caught} caught</span>
          <span className="gauge-count gauge-count-threat">{missed} missed</span>
          <span className="gauge-count gauge-count-alert">{falseAlerts} false</span>
        </div>
      </Gauge>
      <div className={`hud-outcome hud-outcome-${status}`} role="status">
        {outcomeText(status, failureReason)}
      </div>
    </div>
  );
}
