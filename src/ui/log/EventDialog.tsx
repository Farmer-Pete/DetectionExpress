/**
 * The event dialog (GH124-PLAN.md Checkpoint 5): the adaptive detail modal for
 * whatever row the player last clicked in the unified log or a place dialog's scoped
 * log. It renders only while the map/event dialog stack's TOP entry
 * (`topMapDialogEntry`) is an `"event"` entry, reading the stack and the live
 * `snapshot` straight from the store, builds `eventDetail` fresh each render, so its
 * content tracks the running sim. Like `PlaceDialog`, opening it does NOT freeze the
 * engine — `App`'s `modalOpen` still makes the shell `inert`, but the sim keeps
 * stepping underneath.
 *
 * The store reconciles the stack's `"event"` entries on every `setSnapshot`
 * (mirroring `selection`/`decisionSelection`): the moment the ring evicts this row's
 * entry, wherever it sits in the stack, the store filters it out. When it was the top
 * entry, this component stops rendering (or the entry beneath it takes over), which is
 * the "close on evict" contract — there is no separate close-detection effect here.
 *
 * Follows `PlaceDialog`'s (and `TraceOverlay`'s) shape and shared `src/ui/focus.ts`
 * plumbing: `role="dialog"`, a backdrop that dismisses the whole stack on a genuine
 * outside click, focus moves in whenever this dialog becomes the stack's top entry,
 * Tab/Shift+Tab wrap at the dialog's edges, and on a FULL close focus restores to
 * whatever triggered this dialog-stack session's very first, "outside", open —
 * falling back to `fallbackFocusRef` (the log panel, wired by `App`) ONLY when this
 * dialog is the one that rooted the session; a map-rooted session that pushed this
 * event dialog on top instead falls back to the place dialog's own fallback (the map
 * region), when that trigger is no longer connected (a row it evicted, or the shell
 * having gone inert out from under it — see `dialog-stack-focus.ts` for why the root
 * trigger AND its fallback are shared with `PlaceDialog` rather than captured
 * independently by each dialog). A "‹ Back"
 * control appears in the header whenever the stack holds more than this one entry
 * (this event dialog was pushed from an "Open place" link inside a PlaceDialog); Esc
 * pops one entry while that control is showing, and only closes the whole stack at
 * the root entry — the × button and the backdrop always close the whole stack,
 * regardless of depth.
 *
 * Every detail kind's "Open place" link (`OpenPlaceButton` below, common to all
 * three — a scored kiosk reading, one whose scored detail has aged out of the
 * inspector ring, and a raw/otherwise reading, since every `WorldLogEvent` carries a
 * `placeId` regardless of kind) calls `openPlaceFromEvent`, which PUSHES a place entry
 * on top of this one instead of replacing it, so a later Back returns here.
 */
import { type KeyboardEvent, type RefObject, useEffect, useRef } from "react";
import { topMapDialogEntry, useGameStore } from "../../game/store";
import type { MapNodeId } from "../../sim/world/presence";
import { sensorCodeFor } from "../../sim/world-log";
import { useMapDialogFocus } from "../dialog-stack-focus";
import { installOutsidePointerDismiss, trapTab } from "../focus";
import { sensorIcon } from "../icons/sensor-icons";
import { eventDetail } from "./event-detail";
import { formatClock, sensorLabel } from "./formatters";

interface EventDialogProps {
  /** Focus-restore fallback for when the root trigger is no longer connected — used
   *  only when THIS dialog roots the session, via `rootFallbackFocusRef` below (see
   *  `dialog-stack-focus.ts`). */
  fallbackFocusRef: RefObject<HTMLElement | null>;
  /** Shared with `PlaceDialog` (owned by `App`): the element that triggered the
   *  current dialog-stack session's very first, "outside", open — see
   *  `dialog-stack-focus.ts` for why this must be shared rather than captured
   *  independently by each dialog. */
  rootTriggerRef: RefObject<Element | null>;
  /** Shared with `PlaceDialog` (owned by `App`): the ROOT session's own fallback
   *  focus ref, captured alongside `rootTriggerRef` above so a full close restores to
   *  whichever dialog opened the session, not whichever one is on top when it closes
   *  — see `dialog-stack-focus.ts`. */
  rootFallbackFocusRef: RefObject<RefObject<HTMLElement | null> | null>;
}

export function EventDialog({
  fallbackFocusRef,
  rootTriggerRef,
  rootFallbackFocusRef,
}: EventDialogProps) {
  const stack = useGameStore((state) => state.mapDialogStack);
  const snapshot = useGameStore((state) => state.snapshot);
  const clearMapDialogStack = useGameStore((state) => state.clearMapDialogStack);
  const popMapDialog = useGameStore((state) => state.popMapDialog);
  const openPlaceFromEvent = useGameStore((state) => state.openPlaceFromEvent);

  const top = topMapDialogEntry(stack);
  const open = top !== null && top.kind === "event";
  const eventId = open ? top.id : null;
  // More than this one entry means an "Open place" link inside a PlaceDialog pushed
  // this event dialog on top of it, so a "‹ Back" can pop back to it.
  const canGoBack = stack.length > 1;
  const ev = eventId === null ? undefined : snapshot.worldEvents.find((e) => e.id === eventId);
  const detail =
    ev === undefined
      ? null
      : eventDetail(ev, snapshot.events, snapshot.findings, snapshot.decisions);

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
    // A backdrop click always closes the WHOLE stack, not just this entry.
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

  // `ev`/`detail` are both null while closed, or (defensively) if the selected id
  // somehow named nothing live — reconciliation should make this unreachable in
  // practice, mirroring PlaceDialog's own defensive-only branch.
  if (ev === undefined || detail === null) {
    return null;
  }

  const { Icon, token } = sensorIcon(sensorCodeFor(ev.sensor));

  return (
    <div className="place-overlay-backdrop">
      <div
        ref={dialogRef}
        className="place-overlay event-overlay"
        role="dialog"
        aria-modal="true"
        aria-label={`${sensorLabel(ev.sensor)} reading`}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <header className="place-overlay-header">
          {canGoBack ? (
            <button type="button" className="place-overlay-back" onClick={popMapDialog}>
              <span aria-hidden="true">‹</span> Back
            </button>
          ) : null}
          <Icon className="place-overlay-icon" size={20} color={token} aria-hidden="true" />
          <span className="place-overlay-title">{sensorLabel(ev.sensor)}</span>
          <span className="place-meta-badge">{formatClock(ev.ts)}</span>
          <button
            type="button"
            className="place-overlay-close"
            aria-label="Close"
            onClick={clearMapDialogStack}
          >
            <span aria-hidden="true">×</span>
          </button>
        </header>

        {detail.kind === "scored" ? (
          <>
            <EventJsonSection title="Raw" value={detail.raw} />
            <EventJsonSection title="Normalized" value={detail.normalized} />
            <CitationsSection findings={detail.citingFindings} decisions={detail.citingDecisions} />
          </>
        ) : detail.kind === "scored-evicted" ? (
          <>
            <EventJsonSection title="Raw" value={detail.raw} />
            <p className="event-detail-note" data-testid="event-detail-evicted-note">
              Normalized detail no longer retained.
            </p>
            <CitationsSection findings={detail.citingFindings} decisions={detail.citingDecisions} />
          </>
        ) : (
          <>
            <EventJsonSection title="Raw" value={detail.raw} />
            <section className="place-devices" aria-label="Source">
              <h3 className="place-section-title">Source</h3>
              <p className="event-detail-source">
                {detail.source.actorId !== undefined ? `${detail.source.actorId} at ` : ""}
                {detail.source.placeId}
              </p>
            </section>
          </>
        )}
        <OpenPlaceButton placeId={ev.placeId} onOpenPlace={openPlaceFromEvent} />
      </div>
    </div>
  );
}

/**
 * The "Open place" link: common to every detail kind, not just the raw/otherwise
 * branch, since every `WorldLogEvent` carries a `placeId` regardless of whether the
 * reading was scored. Clicking it PUSHES a place entry naming `placeId` onto the
 * map/event dialog stack, on top of the event dialog it was clicked from, so a Back
 * returns to that event.
 */
function OpenPlaceButton({
  placeId,
  onOpenPlace,
}: {
  placeId: MapNodeId;
  onOpenPlace: (placeId: MapNodeId) => void;
}) {
  return (
    <button type="button" className="event-open-place" onClick={() => onOpenPlace(placeId)}>
      Open place
    </button>
  );
}

/** One raw/normalized JSON block, matching TraceOverlay's `<pre>` cards. */
function EventJsonSection({ title, value }: { title: string; value: unknown }) {
  return (
    <section className="place-devices" aria-label={title}>
      <h3 className="place-section-title">{title}</h3>
      <pre className="trace-card-raw">{JSON.stringify(value, null, 2)}</pre>
    </section>
  );
}

/** The findings/decisions that cite this scored event, when any do. */
function CitationsSection({
  findings,
  decisions,
}: {
  findings: readonly { seq: number; reason: string }[];
  decisions: readonly { seq: number; outcome: string }[];
}) {
  if (findings.length === 0 && decisions.length === 0) {
    return null;
  }
  return (
    <section className="place-actors" aria-label="Citations">
      <h3 className="place-section-title">Cited by</h3>
      <ul className="place-actor-list">
        {findings.map((finding) => (
          <li className="place-actor-row" key={`finding-${finding.seq}`}>
            finding · {finding.reason}
          </li>
        ))}
        {decisions.map((decision) => (
          <li className="place-actor-row" key={`decision-${decision.seq}`}>
            decision · {decision.outcome}
          </li>
        ))}
      </ul>
    </section>
  );
}
