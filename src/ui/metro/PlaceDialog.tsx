/**
 * The place dialog (GH124-PLAN.md Checkpoint 4): a centered modal for whatever the
 * player last clicked or activated on the map, a station, a site, the OCC, or a
 * train. It renders only while the map/event dialog stack's TOP entry
 * (`topMapDialogEntry`) is a `"place"` entry, reading the stack and the live
 * `snapshot` straight from the store, so its content tracks the running sim tick by
 * tick. Unlike `TraceOverlay.tsx` and the side panel, opening it does NOT freeze the
 * engine: `App`'s `modalOpen` still makes the shell `inert` (through `ModalHost`) so
 * the player cannot reach anything behind it, but the sim keeps stepping and this
 * dialog keeps re-rendering as it does.
 *
 * The backdrop, header (Back and Close controls), Escape/Tab handling, outside-click
 * dismissal, and focus lifecycle all live in the shared `MapDialogShell`, which
 * `EventDialog` renders too, so the two never drift. This component only picks its
 * own visibility off the stack's top entry, builds its header slots (icon, title,
 * meta badges) and its body, and hands them to the shell. `fallbackFocusRef`,
 * `rootTriggerRef`, and `rootFallbackFocusRef` pass straight through to the shell's
 * focus wiring (see `dialog-stack-focus.ts` for why the root trigger and its fallback
 * are shared with `EventDialog` rather than captured independently by each dialog).
 */
import type { RefObject } from "react";
import { topMapDialogEntry, useGameStore } from "../../game/store";
import { world } from "../../sim/world/world";
import { sensorCodeFor, type WorldLogEvent } from "../../sim/world-log";
import { placeIcon, sensorIcon } from "../icons/sensor-icons";
import { formatClock, toLogRow } from "../log/formatters";
import { MapDialogShell } from "../MapDialogShell";
import { type ActorSummaryRow, type DeviceView, placeView, ROLE_LABEL } from "./place-view";

/**
 * A small color per actor kind for the ACTORS table's glyph dot, matching the map's
 * own per-kind treatment (`ActorLayer.tsx`) where one exists: `--ink` for a rider,
 * `--s-kiosk` for an account rider (it reads as "at the kiosk" there too), `--ok` for
 * staff, `--s-train` for a train, `--threat` for a pin-attacker (the map rings it in
 * the same color). A host/operator has no map glyph of its own (it is drawn only as
 * its command/relay flash), so it gets a neutral fixture tone here instead.
 */
const ACTOR_GLYPH_COLOR: Record<ActorSummaryRow["kind"], string> = {
  rider: "var(--ink)",
  "account-rider": "var(--s-kiosk)",
  train: "var(--s-train)",
  staff: "var(--ok)",
  operator: "var(--a3)",
  host: "var(--a3)",
  "pin-attacker": "var(--threat)",
};

interface PlaceDialogProps {
  /** Focus-restore fallback for when the root trigger is no longer connected — used
   *  only when THIS dialog roots the session, via `rootFallbackFocusRef` below (see
   *  `dialog-stack-focus.ts`). */
  fallbackFocusRef: RefObject<HTMLElement | null>;
  /** Shared with `EventDialog` (owned by `App`): the element that triggered the
   *  current dialog-stack session's very first, "outside", open — see
   *  `dialog-stack-focus.ts` for why this must be shared rather than captured
   *  independently by each dialog. */
  rootTriggerRef: RefObject<Element | null>;
  /** Shared with `EventDialog` (owned by `App`): the ROOT session's own fallback
   *  focus ref, captured alongside `rootTriggerRef` above so a full close restores to
   *  whichever dialog opened the session, not whichever one is on top when it closes
   *  — see `dialog-stack-focus.ts`. */
  rootFallbackFocusRef: RefObject<RefObject<HTMLElement | null> | null>;
}

export function PlaceDialog({
  fallbackFocusRef,
  rootTriggerRef,
  rootFallbackFocusRef,
}: PlaceDialogProps) {
  const stack = useGameStore((state) => state.mapDialogStack);
  const snapshot = useGameStore((state) => state.snapshot);
  const openEventFromPlace = useGameStore((state) => state.openEventFromPlace);

  const top = topMapDialogEntry(stack);
  const open = top !== null && top.kind === "place";
  const selection = open ? top.selection : null;
  const view = selection === null ? null : placeView(selection, snapshot, world);

  if (view === null) {
    return null;
  }

  const Icon = view.iconKind === undefined ? null : placeIcon(view.iconKind);

  return (
    <MapDialogShell
      ariaLabel={view.title}
      title={view.title}
      icon={
        Icon !== null ? <Icon className="place-overlay-icon" size={20} aria-hidden="true" /> : null
      }
      meta={view.meta.map((badge) => (
        <span className="place-meta-badge" key={`${badge.label}:${badge.value}`}>
          {badge.label === "Line" ? badge.value : `${badge.label} ${badge.value}`}
        </span>
      ))}
      stackLength={stack.length}
      fallbackFocusRef={fallbackFocusRef}
      rootTriggerRef={rootTriggerRef}
      rootFallbackFocusRef={rootFallbackFocusRef}
    >
      <section className="place-devices" aria-label="Devices">
        <h3 className="place-section-title">Devices</h3>
        {view.devices.length === 0 ? (
          <p className="place-section-empty">No devices here.</p>
        ) : (
          <ul className="place-device-list">
            {view.devices.map((device) => (
              <DeviceCard key={device.code} device={device} />
            ))}
          </ul>
        )}
      </section>

      <section className="place-actors" aria-label="Actors">
        <h3 className="place-section-title" id="place-actors-title">
          Actors
        </h3>
        {view.actorRows.length === 0 ? (
          <p className="place-section-empty">No one here right now.</p>
        ) : (
          <table className="actor-table" aria-labelledby="place-actors-title">
            <thead>
              <tr>
                <th>Actor</th>
                <th>Activity</th>
                <th className="actor-table-count-header">Count</th>
              </tr>
            </thead>
            <tbody>
              {view.actorRows.map((row) => (
                <ActorTableRow key={`${row.kind}:${row.activity}`} row={row} />
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="place-log" aria-label="Log">
        <h3 className="place-section-title">Log</h3>
        {view.log.length === 0 ? (
          <p className="place-section-empty">No activity logged here yet.</p>
        ) : (
          <div className="log-stream place-log-stream">
            {view.log.map((event) => (
              <PlaceLogRow key={event.id} event={event} onSelect={openEventFromPlace} />
            ))}
          </div>
        )}
      </section>
    </MapDialogShell>
  );
}

/** One device card: its sensor icon, human name, description, vendor list, and
 *  access state — every field sourced from `sensors.data` via `sensor-catalogue`
 *  (GH127-PLAN.md M2), never the raw sensor id. */
function DeviceCard({ device }: { device: DeviceView }) {
  const { Icon, token } = sensorIcon(device.code);
  return (
    <li className="place-device-card">
      <Icon size={16} color={token} aria-hidden="true" />
      <span className="place-device-name">{device.name}</span>
      <span className="place-device-description">{device.description}</span>
      {device.vendors.length > 0 ? (
        <span className="place-device-vendors">{device.vendors.join(", ")}</span>
      ) : null}
      <span className="place-device-state">{device.state}</span>
    </li>
  );
}

/**
 * One aggregated ACTORS row (GH124-PLAN.md Checkpoint 4 Part 4): a kind glyph + label,
 * its shared activity phrase, and how many actors are doing exactly that right now.
 * A pin-attacker row (`row.tone === "threat"`) renders in the threat color, so a
 * player spots an attacker in the table before opening a single finding.
 */
function ActorTableRow({ row }: { row: ActorSummaryRow }) {
  return (
    <tr className={row.tone === "threat" ? "actor-table-row-threat" : undefined}>
      <td className="actor-table-actor">
        <span
          className="actor-table-glyph"
          style={{ background: ACTOR_GLYPH_COLOR[row.kind] }}
          aria-hidden="true"
        />
        {ROLE_LABEL[row.kind]}
      </td>
      <td className="actor-table-activity">{row.activity}</td>
      <td className="actor-table-count">{row.count}</td>
    </tr>
  );
}

/**
 * One scoped-log row (GH124-PLAN.md Checkpoint 5): the SAME `toLogRow` mapping the
 * unified log panel uses, so the two never drift in how they describe a reading.
 * Clicking it PUSHES an event entry naming this row's world-log id onto the
 * map/event dialog stack, so the event dialog opens on top of this place dialog
 * rather than replacing it — a Back returns here.
 */
function PlaceLogRow({
  event,
  onSelect,
}: {
  event: WorldLogEvent;
  onSelect: (id: number) => void;
}) {
  const row = toLogRow(event);
  const { Icon, token } = sensorIcon(sensorCodeFor(event.sensor));
  return (
    <button
      type="button"
      className={`log-row log-row-${row.tone}`}
      data-testid={`place-log-row-${event.id}`}
      onClick={(clickEvent) => {
        clickEvent.currentTarget.focus();
        onSelect(event.id);
      }}
    >
      <span className="log-row-time">{formatClock(row.ts)}</span>
      <span className="log-row-sensor">
        <Icon size={14} color={token} aria-hidden="true" />
      </span>
      <span className="log-row-who">{row.who}</span>
      <span className="log-row-where">{row.where}</span>
      <span className="log-row-result">{row.result}</span>
    </button>
  );
}
