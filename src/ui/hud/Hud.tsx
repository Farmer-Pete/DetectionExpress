/**
 * The Metrics tab body (GH124-PLAN.md Checkpoint 2): the four gauges, stacked to
 * the side panel's width, plus the caught/missed/false counts. Reads live sim
 * values through primitive selectors, one per gauge — the same shape this used to
 * render as the top HUD strip, before the strip moved into `SidePanel`'s Metrics
 * tab. The run-status pill it used to render alongside the gauges now lives in the
 * top bar instead (`StatusPill.tsx`), reading the same shared `outcomeText()`.
 */

import { useGameStore } from "../../game/store";
import { CHANNEL_CAP, OMEGA } from "../../game/tuning";
import { Gauge } from "../gauges/Gauge";
import { severityFill, severityLevel } from "./severity";

/** The effective Queue ceiling: the two upstream channels fill; the Sink drains at once. */
const QUEUE_MAX = 2 * CHANNEL_CAP;

/**
 * The Compute ceiling, in ticks per Event. The naive default rule measures at
 * about one anchor-unit, so its service rate lands near OMEGA and its cost near
 * `1 / OMEGA`. A full-scale of `2 / OMEGA` puts that naive cost mid-gauge, so the
 * Optimization's far lower cost reads as a clear drop.
 */
const COMPUTE_MAX = 2 / OMEGA;

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
  // The Queue the player sees is the authoritative outstanding count,
  // `admitted - completed`, the same value the checkpoint fails on. The channel
  // sum can read zero on the terminal frame while an Event is still in service,
  // so it must not drive this gauge (GH3-PLAN.md 5.5).
  const admitted = useGameStore((state) => state.snapshot.admitted);
  const completed = useGameStore((state) => state.snapshot.completed);
  const queued = admitted - completed;
  const rolling = useGameStore((state) => state.snapshot.correctness.rolling);
  const caught = useGameStore((state) => state.snapshot.correctness.caught);
  const missed = useGameStore((state) => state.snapshot.correctness.missed);
  const falseAlerts = useGameStore((state) => state.snapshot.correctness.falseAlerts);
  const compute = useGameStore((state) => state.snapshot.compute);
  const status = useGameStore((state) => state.snapshot.status);
  // The severity fill color persists on a frozen terminal frame; only the
  // ANIMATED heartbeat pulse gates on run conclusion (F004+F006), the same
  // family rule LogPanel's queue bar and FindingsPanel's border follow.
  const running = status === "running";
  return (
    <div className="metrics-gauges">
      <Gauge label="Throughput" value={throughput} max={20} unit="/s" fill="var(--a1)" />
      <Gauge
        label="Queue"
        value={queued}
        max={QUEUE_MAX}
        unit=""
        fill={severityFill(queued / QUEUE_MAX)}
        pulse={running && severityLevel(queued / QUEUE_MAX) === "danger"}
      />
      <Gauge
        label="Compute"
        value={compute}
        max={COMPUTE_MAX}
        unit=""
        digits={2}
        fill={severityFill(compute / COMPUTE_MAX)}
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
