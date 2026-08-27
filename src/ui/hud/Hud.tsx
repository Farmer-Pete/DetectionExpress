/** The HUD strip. Reads live sim values through primitive selectors, one per gauge. */

import { useGameStore } from "../../game/store";
import { CHANNEL_CAP } from "../../game/tuning";
import { Gauge } from "../gauges/Gauge";

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

export function Hud() {
  const throughput = useGameStore((state) => state.snapshot.throughput);
  const backlog = useGameStore((state) => state.snapshot.backlog);
  const rolling = useGameStore((state) => state.snapshot.correctness.rolling);
  const caught = useGameStore((state) => state.snapshot.correctness.caught);
  const missed = useGameStore((state) => state.snapshot.correctness.missed);
  const falseAlerts = useGameStore((state) => state.snapshot.correctness.falseAlerts);
  return (
    <div className="hud">
      <Gauge label="Throughput" value={throughput} max={20} unit="/s" fill="var(--a1)" />
      <Gauge
        label="Backlog"
        value={backlog}
        max={CHANNEL_CAP}
        unit=""
        fill={backlogFill(backlog / CHANNEL_CAP)}
      />
      <Gauge label="Correctness" value={rolling} max={100} unit="" fill={correctnessFill(rolling)}>
        <div className="gauge-counts">
          <span className="gauge-count gauge-count-ok">{caught} caught</span>
          <span className="gauge-count gauge-count-threat">{missed} missed</span>
          <span className="gauge-count gauge-count-alert">{falseAlerts} false</span>
        </div>
      </Gauge>
    </div>
  );
}
