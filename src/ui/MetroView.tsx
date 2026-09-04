/**
 * The embedded metro map region (GH117 Part F): the map, the transient wave-outcome
 * banner over it (`WaveOutcomeBanner`, GH126-PLAN.md M3b), and the key (Lines,
 * Actors, Sensors) as a sibling of the map inside `.metro-view`. The banner replaces
 * the earlier "simulation ended" won/lost overlay: the endless baseline never
 * concludes (GH126-PLAN.md), so a per-wave held/breach reading is the outcome that
 * matters now, not a terminal one. `MetroKey` renders once; `.metro-view`'s CSS grid
 * (src/index.css) is what moves it — below the map as a row of columns on narrow
 * screens, a left rail of stacked sections at or above the 720px breakpoint. It sits
 * inline in `App`'s page flow between `Hud` and `InspectorShell`, sized to a bounded
 * box rather than filling the viewport — the pipeline transport (freeze, 0.5x/1x/2x)
 * is the one clock now, so this component owns no header, no counts, and no speed
 * control.
 *
 * Every live value is read through a per-field `useGameStore` selector, so a snapshot
 * update re-renders only the panel that reads the changed field, not the whole view
 * (ARCHITECTURE rule 4). The map's hot path (moving actors, flashes) is the canvas
 * layer, not React.
 *
 * GH124-PLAN.md Checkpoint 4: `onSelect` and `mapRegionRef` pass straight through to
 * `MetroMap`/the map region — App owns the actual selection state (the store's
 * `mapDialogStack`) and the place dialog's focus-restore fallback, so this component
 * stays a thin relay for both, the same way it already relays nothing else of its own.
 */

import type { RefObject } from "react";
import { sensorCatalogueEntry } from "../game/sensor-catalogue";
import type { MapSelection } from "../game/store";
import type { SensorCode } from "../sim/world/layout";
import { SENSOR_ID } from "../sim/world/layout";
import { world } from "../sim/world/world";
import { sensorIcon } from "./icons/sensor-icons";
import { MetroMap } from "./MetroMap";
import { WaveOutcomeBanner } from "./wave/WaveOutcomeBanner";

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

interface MetroViewProps {
  /** Lifted selection handler (GH124-PLAN.md Checkpoint 4), forwarded to `MetroMap`. */
  onSelect: (selection: MapSelection) => void;
  /** The map region's ref, for the place dialog's focus-restore fallback (App owns
   *  the ref; `tabIndex={-1}` here makes it programmatically focusable without
   *  joining the Tab order, mirroring `DecisionsPanel.tsx`'s own panel ref). */
  mapRegionRef?: RefObject<HTMLDivElement | null> | undefined;
}

export function MetroView({ onSelect, mapRegionRef }: MetroViewProps) {
  return (
    <div className="metro-view">
      {/* Two grid children, not overlays: the map region (so the full map, Harbor to
          World's End, and every site, is never hidden under a panel) and the key,
          each placed by `.metro-view`'s CSS grid areas — no width check here. */}
      <div className="metro-map-region" ref={mapRegionRef} tabIndex={-1} data-tour="map">
        <MetroMap onSelect={onSelect} />
        <WaveOutcomeBanner />
      </div>
      <MetroKey />
    </div>
  );
}
