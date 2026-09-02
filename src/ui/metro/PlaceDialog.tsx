/**
 * The place dialog (GH124-PLAN.md Checkpoint 4): a centered modal for whatever the
 * player last clicked or activated on the map — a station, a site, the OCC, or a
 * train. It renders only while the map/event dialog stack's TOP entry
 * (`topMapDialogEntry`) is a `"place"` entry, reading the stack and the live
 * `snapshot` straight from the store, so its content tracks the running sim tick by
 * tick. Unlike `TraceOverlay.tsx` and the side panel, opening it does NOT freeze the
 * engine: `App`'s `modalOpen` still makes the shell `inert` (through `ModalHost`) so
 * the player cannot reach anything behind it, but the sim keeps stepping and this
 * dialog keeps re-rendering as it does.
 *
 * Follows `TraceOverlay`'s dialog shape and its shared `src/ui/focus.ts` plumbing:
 * `role="dialog"`, a backdrop that dismisses (the whole stack) on a genuine outside
 * click, focus moves in whenever this dialog becomes the stack's top entry,
 * Tab/Shift+Tab wrap at the dialog's edges, and on a FULL close focus restores to
 * whatever triggered this dialog-stack session's very first, "outside", open —
 * falling back to `fallbackFocusRef` (the metro map region, wired by `App`) ONLY when
 * this dialog is the one that rooted the session; an event-rooted session that pushed
 * this place dialog on top instead falls back to the event dialog's own fallback (the
 * log panel), mirroring `TraceOverlay`'s decision 14 fallback (see
 * `dialog-stack-focus.ts` for why the root trigger AND its fallback are shared with
 * `EventDialog` rather than captured independently by each dialog). A "‹ Back" control appears in
 * the header whenever the stack holds more than this one entry (i.e. this place
 * dialog was pushed from a scoped-log row inside an EventDialog); Esc pops one entry
 * while that control is showing, and only closes the whole stack at the root entry —
 * the × button and the backdrop always close the whole stack, regardless of depth.
 */
import { type KeyboardEvent, type RefObject, useEffect, useRef } from "react";
import { topMapDialogEntry, useGameStore } from "../../game/store";
import { world } from "../../sim/world/world";
import { sensorCodeFor, type WorldLogEvent } from "../../sim/world-log";
import { useMapDialogFocus } from "../dialog-stack-focus";
import { installOutsidePointerDismiss, trapTab } from "../focus";
import { placeIcon, sensorIcon } from "../icons/sensor-icons";
import { formatClock, toLogRow } from "../log/formatters";
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
  const clearMapDialogStack = useGameStore((state) => state.clearMapDialogStack);
  const popMapDialog = useGameStore((state) => state.popMapDialog);
  const openEventFromPlace = useGameStore((state) => state.openEventFromPlace);

  const top = topMapDialogEntry(stack);
  const open = top !== null && top.kind === "place";
  const selection = open ? top.selection : null;
  // More than this one entry means a scoped-log row inside an EventDialog pushed this
  // place dialog on top of it, so a "‹ Back" can pop back to it.
  const canGoBack = stack.length > 1;
  const view = selection === null ? null : placeView(selection, snapshot, world);

  const dialogRef = useRef<HTMLDivElement>(null);

  // Move focus into the dialog whenever it becomes (or stays) the stack's top entry;
  // restore it only on a full close, falling back when the root trigger has since
  // left the document — see `dialog-stack-focus.ts` for why a push or a pop touches
  // neither the capture nor the restore.
  useMapDialogFocus({
    isTop: open,
    stackLength: stack.length,
    dialogRef,
    fallbackFocusRef,
    rootTriggerRef,
    rootFallbackFocusRef,
  });

  useEffect(() => {
    if (!open) {
      return;
    }
    // A backdrop click always closes the WHOLE stack, not just this entry — it is
    // the "give up and leave" gesture, not a Back.
    return installOutsidePointerDismiss(dialogRef, clearMapDialogStack);
  }, [open, clearMapDialogStack]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      if (canGoBack) {
        popMapDialog();
      } else {
        clearMapDialogStack();
      }
      return;
    }
    const dialog = dialogRef.current;
    if (dialog === null) {
      return;
    }
    trapTab(dialog, event);
  };

  if (view === null) {
    return null;
  }

  const Icon = view.iconKind === undefined ? null : placeIcon(view.iconKind);

  return (
    <div className="place-overlay-backdrop">
      <div
        ref={dialogRef}
        className="place-overlay"
        role="dialog"
        aria-modal="true"
        aria-label={view.title}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <header className="place-overlay-header">
          {canGoBack ? (
            <button type="button" className="place-overlay-back" onClick={popMapDialog}>
              <span aria-hidden="true">‹</span> Back
            </button>
          ) : null}
          {Icon !== null ? (
            <Icon className="place-overlay-icon" size={20} aria-hidden="true" />
          ) : null}
          <span className="place-overlay-title">{view.title}</span>
          {view.meta.map((badge) => (
            <span className="place-meta-badge" key={`${badge.label}:${badge.value}`}>
              {badge.label === "Line" ? badge.value : `${badge.label} ${badge.value}`}
            </span>
          ))}
          <button
            type="button"
            className="place-overlay-close"
            aria-label="Close"
            onClick={clearMapDialogStack}
          >
            <span aria-hidden="true">×</span>
          </button>
        </header>

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
          <h3 className="place-section-title">Actors</h3>
          {view.actorRows.length === 0 ? (
            <p className="place-section-empty">No one here right now.</p>
          ) : (
            <table className="actor-table">
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
      </div>
    </div>
  );
}

/** One device card: its sensor icon, human name, canonical detail, and access state. */
function DeviceCard({ device }: { device: DeviceView }) {
  const { Icon, token } = sensorIcon(device.code);
  return (
    <li className="place-device-card">
      <Icon size={16} color={token} aria-hidden="true" />
      <span className="place-device-name">{device.name}</span>
      {device.detail !== undefined ? (
        <span className="place-device-detail">{device.detail}</span>
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
