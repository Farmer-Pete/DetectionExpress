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

export function Hud() {
  const throughput = useGameStore((state) => state.snapshot.throughput);
  const backlog = useGameStore((state) => state.snapshot.backlog);
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
    </div>
  );
}
