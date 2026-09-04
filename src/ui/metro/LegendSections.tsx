/**
 * The Lines/Actors/Sensors legend content (GH133-PLAN.md), extracted from
 * `MetroView.tsx` so it has exactly one active render target at a time
 * (GH133-PLAN.md "One active legend at a time"): `MetroKey` (the desktop rail,
 * `MetroView.tsx`) renders it inline, and `LegendDialog.tsx` renders it inside the
 * mobile legend dialog. Neither ever renders while the other does — the rail is
 * CSS-hidden below 720px, and the dialog only mounts while its own `legendOpen` is
 * true (never on desktop, since the chip that opens it is hidden there) — so this
 * component's own markup and classes (`metro-key-col`, `metro-key-head`,
 * `metro-key-row`, `metro-chip-swatch`) stay a single source both callers share.
 */
import { sensorCatalogueEntry } from "../../game/sensor-catalogue";
import type { SensorCode } from "../../sim/world/layout";
import { SENSOR_ID } from "../../sim/world/layout";
import { world } from "../../sim/world/world";
import { sensorIcon } from "../icons/sensor-icons";

/** The map's line draw order; any line not listed sorts last. */
const LINE_ORDER: readonly string[] = ["red", "blue", "green", "circle"];

/** A line's rank in the draw order, or `Infinity` for an unlisted line (sorts last). */
const lineRank = (id: string): number => {
  const index = LINE_ORDER.indexOf(id);
  return index === -1 ? Number.POSITIVE_INFINITY : index;
};

/** The four lines, for the legend, in the map's draw order. */
const LEGEND_LINES = world.lines.slice().sort((a, b) => lineRank(a.id) - lineRank(b.id));

/** The nine sensors, for the legend: code and its curated zone-range annotation
 *  (e.g. "Z0->Z1"). This suffix is hand-curated presentation — note fare-gate uses
 *  "->" while platform-camera uses "/" for the same zones — and isn't derivable
 *  from the data, so it stays a hardcoded per-code string. The display NAME itself
 *  comes from `sensor-catalogue` (the single source of truth, GH127-PLAN.md M2) via
 *  `legendSensorName` below, not from a second name table here. The icon and color
 *  token come from `sensorIcon` (also the single source of truth for those). */
const LEGEND_SENSORS: readonly { code: SensorCode; zones: string }[] = [
  { code: "K", zones: "Z0" },
  { code: "G", zones: "Z0->Z1" },
  { code: "V", zones: "Z0" },
  { code: "C", zones: "Z0/Z1" },
  { code: "R", zones: "Z1-Z4" },
  { code: "D", zones: "Z1-Z4" },
  { code: "T", zones: "Z1/Z3" },
  { code: "N", zones: "Z2-Z4" },
  { code: "O", zones: "Z4" },
];

/** A legend row's display text: the sensor's unified catalogue name plus its
 *  curated zone-range annotation, e.g. "Ticket vending machine (Z0)". Looks the
 *  name up by the code's canonical `sensors.data` id (`SENSOR_ID`, `layout.ts`) so
 *  the legend can never drift from the device cards and log again. */
function legendSensorName(sensor: { code: SensorCode; zones: string }): string {
  const { name } = sensorCatalogueEntry(SENSOR_ID[sensor.code]);
  return `${name} (${sensor.zones})`;
}

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
            {legendSensorName(sensor)}
          </div>
        );
      })}
    </div>
  );
}

/**
 * The Lines, Actors, and Sensors columns, as a fragment: the caller supplies the
 * wrapping element (`.metro-key` for the desktop rail, `.legend-dialog-body` for the
 * mobile dialog) and its own layout.
 */
export function LegendSections() {
  return (
    <>
      <LinesColumn />
      <ActorsColumn />
      <SensorsColumn />
    </>
  );
}
