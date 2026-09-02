/**
 * The place dialog (GH124-PLAN.md Checkpoint 4): a centered modal for whatever the
 * player last clicked or activated on the map — a station, a site, the OCC, or a
 * train. It reads `mapSelection` and the live `snapshot` straight from the store, so
 * its content tracks the running sim tick by tick. Unlike `TraceOverlay.tsx` and the
 * side panel, opening it does NOT freeze the engine: `App`'s `modalOpen` still makes
 * the shell `inert` (through `ModalHost`) so the player cannot reach anything behind
 * it, but the sim keeps stepping and this dialog keeps re-rendering as it does.
 *
 * Follows `TraceOverlay`'s dialog shape and its shared `src/ui/focus.ts` plumbing:
 * `role="dialog"`, a backdrop that dismisses on a genuine outside click, Esc
 * dismisses, focus moves in on open, Tab/Shift+Tab wrap at the dialog's edges, and on
 * close focus restores to whatever triggered the open — falling back to
 * `fallbackFocusRef` (the metro map region, wired by `App`) when that trigger is no
 * longer connected, mirroring `TraceOverlay`'s decision 14 fallback.
 */
import { type KeyboardEvent, type RefObject, useEffect, useRef } from "react";
import { useGameStore } from "../../game/store";
import { world } from "../../sim/world/world";
import { installOutsidePointerDismiss, trapTab } from "../focus";
import { placeIcon, sensorIcon } from "../icons/sensor-icons";
import { type ActorLine, type DeviceView, placeView } from "./place-view";

interface PlaceDialogProps {
  /** Focus-restore fallback for when the trigger element is no longer connected. */
  fallbackFocusRef: RefObject<HTMLElement | null>;
}

export function PlaceDialog({ fallbackFocusRef }: PlaceDialogProps) {
  const selection = useGameStore((state) => state.mapSelection);
  const snapshot = useGameStore((state) => state.snapshot);
  const clearMapSelection = useGameStore((state) => state.clearMapSelection);

  const open = selection !== null;
  const view = selection === null ? null : placeView(selection, snapshot, world);

  const dialogRef = useRef<HTMLDivElement>(null);

  // Move focus into the dialog on open; restore it on close, falling back when the
  // trigger has since left the document (mirrors TraceOverlay.tsx).
  useEffect(() => {
    if (!open) {
      return;
    }
    const trigger = document.activeElement;
    dialogRef.current?.focus();
    return () => {
      if (trigger instanceof HTMLElement && trigger.isConnected) {
        trigger.focus();
      } else {
        fallbackFocusRef.current?.focus();
      }
    };
  }, [open, fallbackFocusRef]);

  useEffect(() => {
    if (!open) {
      return;
    }
    return installOutsidePointerDismiss(dialogRef, clearMapSelection);
  }, [open, clearMapSelection]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      clearMapSelection();
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
            onClick={clearMapSelection}
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
          {view.actors.length === 0 ? (
            <p className="place-section-empty">No one here right now.</p>
          ) : (
            <ul className="place-actor-list">
              {view.actors.map((actorLine) => (
                <ActorRow key={actorLine.id} actorLine={actorLine} />
              ))}
            </ul>
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

/** One actor row: role, id, and its live activity (from `describePresence`). */
function ActorRow({ actorLine }: { actorLine: ActorLine }) {
  return (
    <li className="place-actor-row">
      <span className="place-actor-role">{actorLine.role}</span>
      <span className="place-actor-id">{actorLine.id}</span>
      <span className="place-actor-doing">{actorLine.doing}</span>
      <span className="place-actor-heading">{actorLine.heading}</span>
    </li>
  );
}
