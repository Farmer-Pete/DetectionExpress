/**
 * The metro view chrome: the header (title, live counts, pause and speed controls),
 * the legend pinned top-left, the event-log panel pinned bottom-right, and the map
 * itself filling the rest. Every live value is read through a per-field `useWorldStore`
 * selector, so a snapshot update re-renders only the panel that reads the changed
 * field, not the whole view (ARCHITECTURE rule 4). The map's hot path (moving actors,
 * flashes) is the canvas layer, not React.
 */

import { GAME_SECONDS_PER_TICK } from "../game/tuning";
import { useWorldStore } from "../game/world-store";
import { world } from "../sim/world/world";
import type { TimedWorldReading } from "../sim/world-reading";
import { MetroMap } from "./MetroMap";

/** A game-minute in whole sim ticks, for the trailing taps/min rate. */
const TICKS_PER_MINUTE = 60 / GAME_SECONDS_PER_TICK;

/** How many of the retained log entries the panel shows. */
const LOG_ROWS = 70;

const stationName = new Map(world.stations.map((station) => [station.id, station.name]));

/** The four lines, for the legend, in the map's draw order. */
const LEGEND_LINES = world.lines
  .slice()
  .sort(
    (a, b) =>
      ["red", "blue", "green", "circle"].indexOf(a.id) -
      ["red", "blue", "green", "circle"].indexOf(b.id),
  );

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

/** Taps in the trailing game-minute, from the log's fare-gate readings. */
function tapsPerMinute(log: readonly TimedWorldReading[], nowTick: number): number {
  const cutoff = nowTick - TICKS_PER_MINUTE;
  return log.filter((entry) => entry.reading.sensor === "fare-gate" && entry.tick > cutoff).length;
}

/** One event-log row's human-readable message from a normalized reading. */
function logMessage(entry: TimedWorldReading): string {
  const reading = entry.reading.reading;
  const place = stationName.get(reading.station) ?? reading.station;
  const detail = reading.direction === "in" ? "tap in" : "tap out";
  return `fare gate, ${place}, ${detail} (bal ${reading.balance})`;
}

function Header() {
  const riders = useWorldStore((state) => state.worldSnapshot.counts.riders);
  const trains = useWorldStore((state) => state.worldSnapshot.counts.trains);
  const staff = useWorldStore((state) => state.worldSnapshot.counts.staff);
  const log = useWorldStore((state) => state.worldSnapshot.log);
  const nowTick = useWorldStore((state) => state.worldSnapshot.nowTick);
  const paused = useWorldStore((state) => state.paused);
  const speed = useWorldStore((state) => state.speed);
  const setPaused = useWorldStore((state) => state.setPaused);
  const setSpeed = useWorldStore((state) => state.setSpeed);
  const taps = tapsPerMinute(log, nowTick);

  return (
    <header className="metro-header">
      <div className="metro-title">LIVING METRO</div>
      <div className="metro-counts">
        <span>
          riders <b>{riders}</b>
        </span>
        <span>
          trains <b>{trains}</b>
        </span>
        <span>
          staff <b>{staff}</b>
        </span>
        <span>
          taps/min <b>{taps}</b>
        </span>
      </div>
      <div className="metro-controls">
        <button type="button" className="metro-btn" onClick={() => setPaused(!paused)}>
          {paused ? "Play" : "Pause"}
        </button>
        <input
          className="metro-speed"
          type="range"
          min={0.25}
          max={4}
          step={0.25}
          value={speed}
          aria-label="Speed"
          onChange={(event) => setSpeed(Number(event.target.value))}
        />
        <span className="metro-speed-read">{speed.toFixed(2)}x</span>
      </div>
    </header>
  );
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
  const log = useWorldStore((state) => state.worldSnapshot.log);
  const rows = log.slice(0, LOG_ROWS);
  return (
    <aside className="metro-log">
      <div className="metro-log-head">Event log</div>
      <div className="metro-log-body">
        {rows.map((entry, index) => (
          <div className="metro-log-row" key={`${entry.tick}-${entry.actorId ?? index}`}>
            <span className="metro-log-time">
              {(entry.tick * GAME_SECONDS_PER_TICK).toFixed(1)}s
            </span>
            <span className="metro-chip-swatch" style={{ background: "var(--s-gate)" }}>
              G
            </span>
            <span className="metro-log-msg">{logMessage(entry)}</span>
          </div>
        ))}
      </div>
    </aside>
  );
}

export function MetroView() {
  return (
    <div className="metro-view">
      <Header />
      {/* Layout children, not overlays: the legend is a left column, the log a
          bottom-right region, and the map fills the remainder, so the full map (Harbor
          to World's End, and every site) is never hidden under a panel. */}
      <div className="metro-stage">
        <Legend />
        <div className="metro-map-region">
          <MetroMap />
        </div>
        <EventLog />
      </div>
    </div>
  );
}
