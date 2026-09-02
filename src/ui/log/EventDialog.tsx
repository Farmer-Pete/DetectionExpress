/**
 * The event dialog (GH124-PLAN.md Checkpoint 5): the adaptive detail modal for
 * whatever row the player last clicked in the unified log or a place dialog's scoped
 * log. It reads `eventSelection` (the world-log id alone, never the object) and the
 * live `snapshot` straight from the store, builds `eventDetail` fresh each render, so
 * its content tracks the running sim. Like `PlaceDialog`, opening it does NOT freeze
 * the engine — `App`'s `modalOpen` still makes the shell `inert`, but the sim keeps
 * stepping underneath.
 *
 * The store reconciles `eventSelection` on every `setSnapshot` (mirroring
 * `selection`/`decisionSelection`): the moment the ring evicts this row, the
 * selection clears and this component stops rendering, which is the "close on evict"
 * contract — there is no separate close-detection effect here.
 *
 * Follows `PlaceDialog`'s (and `TraceOverlay`'s) shape and shared `src/ui/focus.ts`
 * plumbing: `role="dialog"`, a backdrop that dismisses on a genuine outside click, Esc
 * dismisses, focus moves in on open, Tab/Shift+Tab wrap at the dialog's edges, and on
 * close focus restores to whatever triggered the open — falling back to
 * `fallbackFocusRef` (the log panel, wired by `App`) when that trigger is no longer
 * connected (a row it evicted, or the "open place" swap having already unmounted it).
 *
 * The "open place" link (the raw/otherwise branch's only action) calls
 * `openPlaceFromEvent`, which closes this selection and opens the place dialog in ONE
 * store update — never two overlapping modals, and never a frame with neither open.
 */
import { type KeyboardEvent, type RefObject, useEffect, useRef } from "react";
import { useGameStore } from "../../game/store";
import { sensorCodeFor } from "../../sim/world-log";
import { installOutsidePointerDismiss, trapTab } from "../focus";
import { sensorIcon } from "../icons/sensor-icons";
import { eventDetail } from "./event-detail";
import { formatClock, sensorLabel } from "./formatters";

interface EventDialogProps {
  /** Focus-restore fallback for when the trigger element is no longer connected. */
  fallbackFocusRef: RefObject<HTMLElement | null>;
}

export function EventDialog({ fallbackFocusRef }: EventDialogProps) {
  const eventId = useGameStore((state) => state.eventSelection);
  const snapshot = useGameStore((state) => state.snapshot);
  const clearEventSelection = useGameStore((state) => state.clearEventSelection);
  const openPlaceFromEvent = useGameStore((state) => state.openPlaceFromEvent);

  const open = eventId !== null;
  const ev = eventId === null ? undefined : snapshot.worldEvents.find((e) => e.id === eventId);
  const detail =
    ev === undefined
      ? null
      : eventDetail(ev, snapshot.events, snapshot.findings, snapshot.decisions);

  const dialogRef = useRef<HTMLDivElement>(null);

  // Move focus into the dialog on open; restore it on close, falling back when the
  // trigger has since left the document (mirrors PlaceDialog.tsx/TraceOverlay.tsx).
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
    return installOutsidePointerDismiss(dialogRef, clearEventSelection);
  }, [open, clearEventSelection]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      clearEventSelection();
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
          <Icon className="place-overlay-icon" size={20} color={token} aria-hidden="true" />
          <span className="place-overlay-title">{sensorLabel(ev.sensor)}</span>
          <span className="place-meta-badge">{formatClock(ev.ts)}</span>
          <button
            type="button"
            className="place-overlay-close"
            aria-label="Close"
            onClick={clearEventSelection}
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
              <button
                type="button"
                className="event-open-place"
                onClick={() => openPlaceFromEvent(detail.source.placeId)}
              >
                Open place
              </button>
            </section>
          </>
        )}
      </div>
    </div>
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
