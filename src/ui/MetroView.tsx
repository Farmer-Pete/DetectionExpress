/**
 * The embedded metro map region (GH117 Part F): the legend pinned to the left, the
 * compact event log pinned bottom-right, the map itself filling the rest, and a
 * "simulation ended" overlay over the map once the run concludes. It sits inline in
 * `App`'s page flow between `Hud` and `InspectorShell`, sized to a bounded box rather
 * than filling the viewport — the pipeline transport (freeze, 0.5x/1x/2x) is the one
 * clock now, so this component owns no header, no counts, and no speed control.
 *
 * Every live value is read through a per-field `useGameStore` selector, so a snapshot
 * update re-renders only the panel that reads the changed field, not the whole view
 * (ARCHITECTURE rule 4). The map's hot path (moving actors, flashes) is the canvas
 * layer, not React.
 */

import { useGameStore } from "../game/store";
import { GAME_SECONDS_PER_TICK } from "../game/tuning";
import type { FailureReason, RunStatus } from "../sim/snapshot";
import { world } from "../sim/world/world";
import type { TimedWorldReading } from "../sim/world-reading";
import { MetroMap } from "./MetroMap";

/** How many of the retained log entries the panel shows. */
const LOG_ROWS = 70;

/** Every named place a reading can cite: the nine stations, the sites, and the OCC. */
const placeName = new Map<string, string>([
  ...world.stations.map((station): [string, string] => [station.id, station.name]),
  ...world.sites.map((site): [string, string] => [site.id, site.name]),
  [world.controlCenter.id, world.controlCenter.name],
]);

/** The map's line draw order; any line not listed sorts last. */
const LINE_ORDER: readonly string[] = ["red", "blue", "green", "circle"];

/** A line's rank in the draw order, or `Infinity` for an unlisted line (sorts last). */
const lineRank = (id: string): number => {
  const index = LINE_ORDER.indexOf(id);
  return index === -1 ? Number.POSITIVE_INFINITY : index;
};

/** The four lines, for the legend, in the map's draw order. */
const LEGEND_LINES = world.lines.slice().sort((a, b) => lineRank(a.id) - lineRank(b.id));

/** The nine sensors, for the legend: code, color token, and name. */
const LEGEND_SENSORS: readonly { code: string; color: string; name: string }[] = [
  { code: "K", color: "var(--s-kiosk)", name: "account kiosk (Z0)" },
  { code: "G", color: "var(--s-gate)", name: "fare gate (Z0->Z1)" },
  { code: "V", color: "var(--s-tvm)", name: "ticket machine (Z0)" },
  { code: "C", color: "var(--s-cam)", name: "platform camera (Z0/Z1)" },
  { code: "R", color: "var(--s-reader)", name: "door reader (Z1-Z4)" },
  { code: "D", color: "var(--s-contact)", name: "door contact (Z1-Z4)" },
  { code: "T", color: "var(--s-train)", name: "train tracker (Z1/Z3)" },
  { code: "N", color: "var(--s-relay)", name: "network relay (Z2-Z4)" },
  { code: "O", color: "var(--s-console)", name: "control console (Z4)" },
];

/** One event-log row: its sensor chip code and color, and its human-readable message. */
function logRow(entry: TimedWorldReading): { code: string; color: string; text: string } {
  const reading = entry.reading;
  if (reading.sensor === "train-tracker") {
    const place = placeName.get(reading.reading.station) ?? reading.reading.station;
    const detail = reading.reading.event === "arr" ? "arrive" : "depart";
    return {
      code: "T",
      color: "var(--s-train)",
      text: `train tracker, ${place}, ${reading.reading.train} ${detail} (${reading.reading.line})`,
    };
  }
  if (reading.sensor === "door-reader") {
    const place = placeName.get(reading.reading.site) ?? reading.reading.site;
    return {
      code: "R",
      color: "var(--s-reader)",
      text: `door reader, ${place}, ${reading.reading.badge} grant ${reading.reading.door} (${reading.reading.zone})`,
    };
  }
  if (reading.sensor === "door-contact") {
    const place = placeName.get(reading.reading.site) ?? reading.reading.site;
    return {
      code: "D",
      color: "var(--s-contact)",
      text: `door contact, ${place}, ${reading.reading.door} ${reading.reading.event}`,
    };
  }
  if (reading.sensor === "kiosk") {
    const place = placeName.get(reading.reading.station) ?? reading.reading.station;
    return {
      code: "K",
      color: "var(--s-kiosk)",
      text: `account kiosk, ${place}, ${reading.reading.account} sign-in (${reading.reading.terminal})`,
    };
  }
  if (reading.sensor === "tvm") {
    const place = placeName.get(reading.reading.station) ?? reading.reading.station;
    return {
      code: "V",
      color: "var(--s-tvm)",
      text: `ticket machine, ${place}, ${reading.reading.card} top-up +${reading.reading.amount} (${reading.reading.machine})`,
    };
  }
  if (reading.sensor === "platform-camera") {
    const place = placeName.get(reading.reading.station) ?? reading.reading.station;
    return {
      code: "C",
      color: "var(--s-cam)",
      text: `platform camera, ${place}, ${reading.reading.persons} people / ${reading.reading.grants} grants`,
    };
  }
  if (reading.sensor === "occ-console") {
    // The console reading is OCC-only and carries no location, so the place is the OCC.
    return {
      code: "O",
      color: "var(--s-console)",
      text: `control console, ${world.controlCenter.name}, ${reading.reading.operator} ${reading.reading.command} ${reading.reading.target} (${reading.reading.host})`,
    };
  }
  if (reading.sensor === "network-relay") {
    const place = placeName.get(reading.reading.site) ?? reading.reading.site;
    return {
      code: "N",
      color: "var(--s-relay)",
      text: `network relay, ${place}, ${reading.reading.host} -> ${reading.reading.dest} ${reading.reading.bytes}B`,
    };
  }
  const place = placeName.get(reading.reading.station) ?? reading.reading.station;
  const detail = reading.reading.direction === "in" ? "tap in" : "tap out";
  return {
    code: "G",
    color: "var(--s-gate)",
    text: `fare gate, ${place}, ${detail} (bal ${reading.reading.balance})`,
  };
}

function Legend() {
  return (
    <aside className="metro-legend">
      <div className="metro-legend-head">Lines</div>
      {LEGEND_LINES.map((line) => (
        <div className="metro-legend-row" key={line.id}>
          <span className="metro-swatch" style={{ background: line.color }} />
          {line.name}
        </div>
      ))}
      <div className="metro-legend-head">Actors</div>
      <div className="metro-legend-row">
        <span className="metro-swatch metro-swatch-dot" style={{ background: "var(--ink)" }} />
        rider
      </div>
      <div className="metro-legend-row">
        {/* A kiosk-colored dot matching the account rider's real glyph (--s-kiosk). */}
        <span className="metro-swatch metro-swatch-dot" style={{ background: "var(--s-kiosk)" }} />
        account rider
      </div>
      <div className="metro-legend-row">
        {/* A red-ringed dot matching the pin attacker's real glyph (GH117 Part F). */}
        <span className="metro-swatch metro-swatch-attacker" />
        pin attacker
      </div>
      <div className="metro-legend-row">
        {/* A square swatch matching the staff's real 7x7 green square glyph (--ok). */}
        <span className="metro-swatch metro-swatch-staff" style={{ background: "var(--ok)" }} />
        staff
      </div>
      <div className="metro-legend-row">
        {/* A rounded-rect swatch matching the train's real pill glyph (#cfe3ea). */}
        <span
          className="metro-swatch metro-swatch-train"
          style={{ background: "var(--s-train)", borderRadius: "3px" }}
        />
        train
      </div>
      <div className="metro-legend-head">Sensors</div>
      {LEGEND_SENSORS.map((sensor) => (
        <div className="metro-legend-row" key={sensor.code}>
          <span className="metro-chip-swatch" style={{ background: sensor.color }}>
            {sensor.code}
          </span>
          {sensor.name}
        </div>
      ))}
    </aside>
  );
}

function EventLog() {
  const log = useGameStore((state) => state.snapshot.mapLog);
  const rows = log.slice(0, LOG_ROWS);
  return (
    <aside className="metro-log">
      <div className="metro-log-head">Event log</div>
      <div className="metro-log-body">
        {rows.map((entry, index) => {
          const row = logRow(entry);
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: two readings from one actor on one tick share (tick, actorId); the row index is the only field that disambiguates them, and these rows hold no state, so a shifting index is harmless.
            <div className="metro-log-row" key={`${entry.tick}-${entry.actorId ?? "?"}-${index}`}>
              <span className="metro-log-time">
                {(entry.tick * GAME_SECONDS_PER_TICK).toFixed(1)}s
              </span>
              <span className="metro-chip-swatch" style={{ background: row.color }}>
                {row.code}
              </span>
              <span className="metro-log-msg">{row.text}</span>
            </div>
          );
        })}
      </div>
    </aside>
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
      {/* Layout children, not overlays: the legend is a left column, the log a
          bottom-right region, and the map fills the remainder, so the full map (Harbor
          to World's End, and every site) is never hidden under a panel. */}
      <Legend />
      <div className="metro-map-region">
        <MetroMap />
        <EndedOverlay />
      </div>
      <EventLog />
    </div>
  );
}
