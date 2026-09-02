/**
 * The embedded metro map region (GH117 Part F): the map, a "simulation ended"
 * overlay over it once the run concludes, and the key (Lines, Actors, Sensors) as a
 * sibling of the map inside `.metro-view`. `MetroKey` renders once; `.metro-view`'s
 * CSS grid (src/index.css) is what moves it — below the map as a row of columns on
 * narrow screens, a left rail of stacked sections at or above the 720px breakpoint.
 * It sits inline in `App`'s page flow between `Hud` and `InspectorShell`, sized to a
 * bounded box rather than filling the viewport — the pipeline transport (freeze,
 * 0.5x/1x/2x) is the one clock now, so this component owns no header, no counts, and
 * no speed control.
 *
 * Every live value is read through a per-field `useGameStore` selector, so a snapshot
 * update re-renders only the panel that reads the changed field, not the whole view
 * (ARCHITECTURE rule 4). The map's hot path (moving actors, flashes) is the canvas
 * layer, not React.
 */

import { useGameStore } from "../game/store";
import type { FailureReason, RunStatus } from "../sim/snapshot";
import type { SensorCode } from "../sim/world/layout";
import { world } from "../sim/world/world";
import { sensorIcon } from "./icons/sensor-icons";
import { MetroMap } from "./MetroMap";

/** The map's line draw order; any line not listed sorts last. */
const LINE_ORDER: readonly string[] = ["red", "blue", "green", "circle"];

/** A line's rank in the draw order, or `Infinity` for an unlisted line (sorts last). */
const lineRank = (id: string): number => {
  const index = LINE_ORDER.indexOf(id);
  return index === -1 ? Number.POSITIVE_INFINITY : index;
};

/** The four lines, for the legend, in the map's draw order. */
const LEGEND_LINES = world.lines.slice().sort((a, b) => lineRank(a.id) - lineRank(b.id));

/** The nine sensors, for the legend: code and name. The icon and color token come
    from `sensorIcon` (the single source of truth), not a second table here. */
const LEGEND_SENSORS: readonly { code: SensorCode; name: string }[] = [
  { code: "K", name: "account kiosk (Z0)" },
  { code: "G", name: "fare gate (Z0->Z1)" },
  { code: "V", name: "ticket machine (Z0)" },
  { code: "C", name: "platform camera (Z0/Z1)" },
  { code: "R", name: "door reader (Z1-Z4)" },
  { code: "D", name: "door contact (Z1-Z4)" },
  { code: "T", name: "train tracker (Z1/Z3)" },
  { code: "N", name: "network relay (Z2-Z4)" },
  { code: "O", name: "control console (Z4)" },
];

/** The Lines column: one swatch-and-name row per line, in the map's draw order. */
function LinesColumn() {
  return (
    <div className="metro-key-col">
      <div className="metro-key-head">Lines</div>
      {LEGEND_LINES.map((line) => (
        <div className="metro-key-row" key={line.id}>
          <span className="metro-swatch" style={{ background: line.color }} />
          {line.name}
        </div>
      ))}
    </div>
  );
}

/** The Actors column: rider, account rider, pin attacker, staff, and train. */
function ActorsColumn() {
  return (
    <div className="metro-key-col">
      <div className="metro-key-head">Actors</div>
      <div className="metro-key-row">
        <span className="metro-swatch metro-swatch-dot" style={{ background: "var(--ink)" }} />
        rider
      </div>
      <div className="metro-key-row">
        {/* A kiosk-colored dot matching the account rider's real glyph (--s-kiosk). */}
        <span className="metro-swatch metro-swatch-dot" style={{ background: "var(--s-kiosk)" }} />
        account rider
      </div>
      <div className="metro-key-row">
        {/* A red-ringed dot matching the pin attacker's real glyph (GH117 Part F). */}
        <span className="metro-swatch metro-swatch-attacker" />
        pin attacker
      </div>
      <div className="metro-key-row">
        {/* A square swatch matching the staff's real 7x7 green square glyph (--ok). */}
        <span className="metro-swatch metro-swatch-staff" style={{ background: "var(--ok)" }} />
        staff
      </div>
      <div className="metro-key-row">
        {/* A rounded-rect swatch matching the train's real pill glyph (#cfe3ea). */}
        <span
          className="metro-swatch metro-swatch-train"
          style={{ background: "var(--s-train)", borderRadius: "3px" }}
        />
        train
      </div>
    </div>
  );
}

/** The Sensors column: one icon-and-name row per sensor, tinted with its color token. */
function SensorsColumn() {
  return (
    <div className="metro-key-col">
      <div className="metro-key-head">Sensors</div>
      {LEGEND_SENSORS.map((sensor) => {
        const { Icon, token } = sensorIcon(sensor.code);
        return (
          <div className="metro-key-row" key={sensor.code}>
            <span className="metro-chip-swatch">
              <Icon size={13} color={token} strokeWidth={2.5} />
            </span>
            {sensor.name}
          </div>
        );
      })}
    </div>
  );
}

/**
 * The key: Lines, Actors, and Sensors. Rendered once, as a sibling of the map region
 * — `.metro-key`'s CSS (not a JS width check) decides whether it lays out as columns
 * below the map or as a stacked rail to its left.
 */
function MetroKey() {
  return (
    <div className="metro-key">
      <LinesColumn />
      <ActorsColumn />
      <SensorsColumn />
    </div>
  );
}

/** The one-line outcome the overlay reads, mirroring `Hud`'s own outcome copy. */
function outcomeText(status: RunStatus, reason: FailureReason) {
  if (status === "won") {
    return "Simulation ended — won";
  }
  return reason === "queue"
    ? "Simulation ended — failed: queue overflowed"
    : reason === "correctness"
      ? "Simulation ended — failed: correctness too low"
      : "Simulation ended — failed";
}

/**
 * A small overlay over the map region once the scored run concludes (GH117 decision
 * 5): the engine has already stopped stepping, so the map beneath it is a frozen
 * terminal frame, and this names the outcome rather than leaving it silently static.
 * Renders nothing while the run is still running.
 */
function EndedOverlay() {
  const status = useGameStore((state) => state.snapshot.status);
  const failureReason = useGameStore((state) => state.snapshot.failureReason);
  if (status === "running") {
    return null;
  }
  return (
    <div className="metro-ended-overlay" role="status">
      {outcomeText(status, failureReason)}
    </div>
  );
}

export function MetroView() {
  return (
    <div className="metro-view">
      {/* Two grid children, not overlays: the map region (so the full map, Harbor to
          World's End, and every site, is never hidden under a panel) and the key,
          each placed by `.metro-view`'s CSS grid areas — no width check here. */}
      <div className="metro-map-region">
        <MetroMap />
        <EndedOverlay />
      </div>
      <MetroKey />
    </div>
  );
}
