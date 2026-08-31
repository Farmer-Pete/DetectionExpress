/**
 * The trace dialog (T9): opened whenever the store's `selection` names a live
 * finding. Left node "Ingest + Normalize" shows one card per cited event, raw over
 * normalized; right node "Judge" shows the finding's context widgets and a verdict
 * line. `selection !== null` IS "the dialog is open" (GH34-35-PLAN.md decision 2):
 * there is no separate open/close flag.
 *
 * It is a real modal dialog, styled on `IntroOverlay`'s pattern: `role="dialog"`,
 * a backdrop that dismisses on click (a click inside the dialog never does), Esc
 * dismisses too, and focus moves in on open. On close it restores focus to the row
 * that opened it, but only if that row `isConnected` — reconciliation may have
 * evicted it (aging, a cap, or a run restart publishing `emptySnapshot()`) — and
 * falls back to `fallbackFocusRef`'s container otherwise (decision 14).
 *
 * Freeze protocol (decision 5): opening freezes the run through the existing
 * transport seam UNLESS it is already frozen, and remembers whether THIS dialog
 * did the freezing. While open, the moment `transport.frozen` goes false (a manual
 * unfreeze) the claim is forfeited permanently, even if the player re-freezes
 * afterward: the ref only ever moves true -> false, never back. On close, the
 * dialog un-freezes only if it still holds an unforfeited claim.
 */
import { type RefObject, useEffect, useRef } from "react";
import { useGameStore } from "../../game/store";
import { formatClock } from "../log/formatters";
import type { TraceCard } from "./trace-view-model";
import { buildTraceViewModel } from "./trace-view-model";
import { prettifyReason } from "./view-model";
import { WidgetList } from "./widgets";

interface TraceOverlayProps {
  /** The focus-fallback container for a trigger reconciliation evicted (decision 14). */
  fallbackFocusRef: RefObject<HTMLElement | null>;
}

export function TraceOverlay({ fallbackFocusRef }: TraceOverlayProps) {
  const selection = useGameStore((state) => state.selection);
  const snapshot = useGameStore((state) => state.snapshot);
  const clearSelection = useGameStore((state) => state.clearSelection);
  const frozen = useGameStore((state) => state.transport.frozen);
  const setFrozen = useGameStore((state) => state.setFrozen);

  const model = selection === null ? null : buildTraceViewModel(snapshot, selection.seq);
  const open = model !== null;

  const dialogRef = useRef<HTMLDivElement>(null);
  // True while THIS open lifecycle both froze the run and still owns that claim. Set
  // once on open (only when the run was not already frozen) and can only move to
  // false afterward (the forfeit), never back to true.
  const initiatedFreeze = useRef(false);
  // Tracks the previous `open` value across renders, so the freeze effect below can
  // tell "just opened" and "just closed" apart from "still open, `frozen` changed".
  const wasOpenRef = useRef(false);

  // Move focus into the dialog on open; restore it on close. The trigger is whatever
  // held focus at the moment the dialog opened (a clicked finding row, natively
  // focused by the browser's click handling before this effect ever runs).
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

  // The freeze protocol, as one explicit transition table over (open, frozen). A
  // single effect, not two: `setFrozen(true)` on open does not retire its own render
  // synchronously, so a second effect reading the same render's `frozen` prop would
  // see the pre-freeze value and immediately (and wrongly) read that as a forfeit.
  // Tracking the previous `open` by ref, instead, lets this effect tell "just opened"
  // and "just closed" apart from "still open, and `frozen` changed under us" using
  // only the fresh `frozen` each dependency-triggered run actually observes.
  useEffect(() => {
    const wasOpen = wasOpenRef.current;
    wasOpenRef.current = open;

    if (open && !wasOpen) {
      // Just opened: claim the freeze unless the run was already frozen (a manual
      // pre-freeze), which carries no claim to release later.
      if (frozen) {
        initiatedFreeze.current = false;
      } else {
        setFrozen(true);
        initiatedFreeze.current = true;
      }
      return;
    }

    if (!open && wasOpen) {
      // Just closed: release the freeze only if this dialog still holds the claim.
      if (initiatedFreeze.current && frozen) {
        setFrozen(false);
      }
      initiatedFreeze.current = false;
      return;
    }

    if (open && wasOpen && !frozen) {
      // Still open, and `frozen` just went false: a manual unfreeze (Space, or the
      // freeze button). Forfeit the claim permanently (decision 5) — this only ever
      // moves true -> false, so a later manual re-freeze cannot re-arm it.
      initiatedFreeze.current = false;
    }
  }, [open, frozen, setFrozen]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      clearSelection();
    }
  };

  // A click outside the dialog, on the backdrop scrim, dismisses it. A click inside
  // the dialog is contained, so it never dismisses. Mirrors IntroOverlay's technique:
  // the listener lives on the document, not the scrim, so the scrim stays presentational.
  useEffect(() => {
    if (!open) {
      return;
    }
    const onDocumentClick = (event: MouseEvent): void => {
      const dialog = dialogRef.current;
      if (dialog !== null && event.target instanceof Node && !dialog.contains(event.target)) {
        clearSelection();
      }
    };
    document.addEventListener("click", onDocumentClick);
    return () => document.removeEventListener("click", onDocumentClick);
  }, [open, clearSelection]);

  if (model === null) {
    return null;
  }

  const ariaLabel = `Trace: ${prettifyReason(model.reason)}`;

  return (
    <div className="trace-overlay-backdrop">
      <div
        ref={dialogRef}
        className="trace-overlay"
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <header className="trace-overlay-header">
          {model.entity !== undefined ? (
            <span className="trace-entity-chip">{model.entity}</span>
          ) : null}
          <span className="trace-reason">{prettifyReason(model.reason)}</span>
          <span className={`trace-state trace-state--${model.state}`}>{model.state}</span>
          <span className="trace-time">{formatClock(model.at)}</span>
          <button
            type="button"
            className="trace-close"
            aria-label="Close trace"
            onClick={clearSelection}
          >
            <span aria-hidden="true">×</span>
          </button>
        </header>
        <div className="trace-nodes">
          <section className="trace-node trace-node-ingest" aria-label="Ingest and Normalize">
            <h3 className="trace-node-title">Ingest + Normalize</h3>
            {model.cards.length === 0 ? (
              <p className="trace-node-empty">No cited events.</p>
            ) : (
              <ul className="trace-cards">
                {model.cards.map((card) => (
                  <TraceCardItem key={card.id} card={card} />
                ))}
              </ul>
            )}
          </section>
          <section className="trace-node trace-node-judge" aria-label="Judge">
            <h3 className="trace-node-title">Judge</h3>
            <WidgetList context={model.context} />
            <p className="trace-verdict">
              {model.state === "hit" ? "finding raised" : "watching, no finding yet"}
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}

/** One cited-event card: an aged-out placeholder, or raw over normalized with its
 *  endpoint and time. */
function TraceCardItem({ card }: { card: TraceCard }) {
  if (card.kind === "aged-out") {
    return (
      <li className="trace-card trace-card--aged-out">
        <span className="trace-card-id">#{card.id}</span>
        <span className="trace-card-aged-note">aged out of the recent stream</span>
      </li>
    );
  }
  return (
    <li className="trace-card">
      <div className="trace-card-meta">
        <span className="trace-card-endpoint">{card.endpoint}</span>
        <span className="trace-card-time">{formatClock(card.ts)}</span>
      </div>
      <pre className="trace-card-raw">{JSON.stringify(card.raw)}</pre>
      <pre className="trace-card-normalized">{JSON.stringify(card.normalized)}</pre>
    </li>
  );
}
