/**
 * The trace dialog: opened whenever the store's `selection` (T9) or `decisionSelection`
 * (T10) names a live finding or a resolved decision. `selection !== null` OR
 * `decisionSelection !== null` IS "the dialog is open" (GH34-35-PLAN.md decision 2);
 * there is no separate open/close flag. The two selections are mutually exclusive at
 * the store, but this component still picks finding mode first if both are somehow
 * set, a defensive tie-break, not a reachable state in practice.
 *
 * Finding mode (T9): left node "Ingest + Normalize" shows one card per cited event,
 * raw over normalized; right node "Judge" shows the finding's context widgets and a
 * verdict line.
 *
 * Decision mode (T10), reopening resolved history from `snapshot.decisions`: a
 * caught or false decision shows the same two-node evidence layout, but resolves its
 * cards against the decision's own frozen `citedEvents` (captured at decision time),
 * never the live `snapshot.events` ring — old history can outlive what the ring still
 * holds. A missed decision shows a solo panel instead: reason and the attack window,
 * no evidence pane (decision 12). Every decision-mode header's "recorded at" reads
 * `resolvedAt` (decision 16), never the player-influenced `at`.
 *
 * It mounts as a sibling of `.app-shell`, in `App.tsx` through `ModalHost`
 * (GH105-PLAN.md), next to `IntroOverlay`. The shell is `inert` while it is open
 * (`ModalHost`'s `modalOpen`), so a screen reader's browse mode and the keyboard
 * cannot reach the findings rows, decisions rows, transport controls, or the editor
 * behind it — only the Tab trap below, which is not enough on its own (browse mode
 * ignores the browser's keyboard focus entirely).
 *
 * It is a real modal dialog, styled on `IntroOverlay`'s pattern: `role="dialog"`,
 * a backdrop that dismisses on click (a gesture STARTING inside the dialog never
 * does, even if it ends on the backdrop — `src/ui/focus.ts`'s
 * `installOutsidePointerDismiss`), Esc dismisses too, focus moves in on open, and
 * Tab/Shift+Tab wrap at the dialog's edges (shared with `IntroOverlay` through
 * `src/ui/focus.ts`). On close it
 * restores focus to the row
 * that opened it, but only if that row `isConnected` — reconciliation may have
 * evicted it (aging, a cap, or a run restart publishing `emptySnapshot()`) — and
 * falls back to the active mode's own container otherwise (decision 14):
 * `fallbackFocusRef` (the findings panel) for a finding, `decisionsFallbackFocusRef`
 * (the decisions panel) for a decision.
 *
 * Freeze protocol (decision 5), shared by both modes: opening freezes the run
 * through the existing transport seam UNLESS it is already frozen, and remembers
 * whether THIS dialog did the freezing. While open, the moment `transport.frozen`
 * goes false (a manual unfreeze) the claim is forfeited permanently, even if the
 * player re-freezes afterward: the ref only ever moves true -> false, never back.
 * On close, the dialog un-freezes only if it still holds an unforfeited claim.
 */
import { type RefObject, useEffect, useRef } from "react";
import { useGameStore } from "../../game/store";
import { outcomeLabel } from "../decisions/view-model";
import { installOutsidePointerDismiss, trapTab } from "../focus";
import { formatClock } from "../log/formatters";
import { Kbd } from "../shortcuts/Kbd";
import { kbdGlyph } from "../shortcuts/shortcuts.data";
import { useShortcut } from "../shortcuts/use-shortcut";
import {
  buildDecisionTraceViewModel,
  buildTraceViewModel,
  type DecisionTraceViewModel,
  type TraceCard,
  type TraceViewModel,
} from "./trace-view-model";
import { prettifyReason, stateLabel } from "./view-model";
import { WidgetList } from "./widgets";

interface TraceOverlayProps {
  /** The finding-mode focus-fallback container (decision 14): the findings panel. */
  fallbackFocusRef: RefObject<HTMLElement | null>;
  /** The decision-mode focus-fallback container (decision 14): the decisions panel. */
  decisionsFallbackFocusRef: RefObject<HTMLElement | null>;
}

/** Which selection is driving the dialog, or neither. */
type TraceMode = "finding" | "decision" | null;

export function TraceOverlay({ fallbackFocusRef, decisionsFallbackFocusRef }: TraceOverlayProps) {
  const selection = useGameStore((state) => state.selection);
  const decisionSelection = useGameStore((state) => state.decisionSelection);
  const snapshot = useGameStore((state) => state.snapshot);
  const clearSelection = useGameStore((state) => state.clearSelection);
  const frozen = useGameStore((state) => state.transport.frozen);
  const setFrozen = useGameStore((state) => state.setFrozen);

  const findingModel = selection === null ? null : buildTraceViewModel(snapshot, selection.seq);
  // Finding selection wins if both are somehow set (see the module doc).
  const decisionModel =
    findingModel === null && decisionSelection !== null
      ? buildDecisionTraceViewModel(snapshot, decisionSelection.seq)
      : null;

  const mode: TraceMode =
    findingModel !== null ? "finding" : decisionModel !== null ? "decision" : null;
  const open = mode !== null;

  const dialogRef = useRef<HTMLDivElement>(null);
  // True while THIS open lifecycle both froze the run and still owns that claim. Set
  // once on open (only when the run was not already frozen) and can only move to
  // false afterward (the forfeit), never back to true.
  const initiatedFreeze = useRef(false);
  // Tracks the previous `open` value across renders, so the freeze effect below can
  // tell "just opened" and "just closed" apart from "still open, `frozen` changed".
  const wasOpenRef = useRef(false);

  // Move focus into the dialog on open; restore it on close. The trigger is whatever
  // held focus at the moment the dialog opened (a clicked row, natively focused by
  // the browser's click handling before this effect ever runs). `mode` is captured
  // by this closure at the render that opened the dialog, NOT read fresh at cleanup
  // time: by the time cleanup runs (the render that closed it), `mode` has already
  // gone back to `null`, so a live-read (a ref updated every render) would always
  // see `null` here and fall through to the wrong fallback.
  useEffect(() => {
    if (!open) {
      return;
    }
    const trigger = document.activeElement;
    const openedInMode = mode;
    dialogRef.current?.focus();
    return () => {
      if (trigger instanceof HTMLElement && trigger.isConnected) {
        trigger.focus();
      } else {
        const fallbackRef =
          openedInMode === "decision" ? decisionsFallbackFocusRef : fallbackFocusRef;
        fallbackRef.current?.focus();
      }
    };
  }, [open, mode, fallbackFocusRef, decisionsFallbackFocusRef]);

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

  // Unmount-only release (F001): the freeze effect above has no cleanup of its own
  // (its dependencies already cover open/close while mounted), so unmounting while
  // this dialog still holds an unforfeited claim would otherwise leak the freeze
  // into the store forever. Since GH105-PLAN.md moved this component to a shell
  // sibling (mounted in both views), a Pipeline<->Metro view toggle no longer
  // unmounts it: the pipeline effect's cleanup in App.tsx calls `clearSelection()`
  // on a view switch, which closes the dialog through its normal close path above
  // and releases the freeze there instead. This effect is now a safety net for a
  // full `App` unmount specifically, a distinct invariant from the close path.
  // `frozen` is read fresh through `getState()`, never the closed-over prop, so a
  // store update between the last render and unmount can't go stale. Deps are just
  // `[setFrozen]`, so this effect's cleanup runs only on unmount, never on an
  // open/frozen change.
  //
  // Resetting `wasOpenRef` here also settles a StrictMode-only hazard: on a fresh
  // mount with the dialog already open, React's dev-mode phantom
  // cleanup+re-setup runs this cleanup once before the freeze effect ever runs
  // again. Left at `true`, the freeze effect's re-setup would read a stale
  // "already open" and land in the forfeit branch instead of re-claiming; zeroing
  // it here makes that re-setup see a fresh not-yet-open state instead.
  useEffect(() => {
    return () => {
      if (initiatedFreeze.current && useGameStore.getState().transport.frozen) {
        setFrozen(false);
      }
      initiatedFreeze.current = false;
      wasOpenRef.current = false;
    };
  }, [setFrozen]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      clearSelection();
      return;
    }
    // Wrap Tab/Shift+Tab at the dialog's edges, shared with IntroOverlay's own
    // trap (src/ui/focus.ts). A missed decision's solo panel carries fewer
    // focusable controls than the evidence layouts; trapTab's own empty-controls
    // guard covers that the same way it covers IntroOverlay's zero-focusable case.
    const dialog = dialogRef.current;
    if (dialog === null) {
      return;
    }
    trapTab(dialog, event);
  };

  // A gesture outside the dialog, on the backdrop scrim, dismisses it — but only a
  // gesture that STARTS outside; one that starts inside (e.g. selecting text in a
  // .trace-card-raw <pre> and releasing over the backdrop) never does. Mirrors
  // IntroOverlay's technique: the listeners live on the document, not the scrim, so
  // the scrim stays presentational. See `installOutsidePointerDismiss`.
  useEffect(() => {
    if (!open) {
      return;
    }
    return installOutsidePointerDismiss(dialogRef, clearSelection);
  }, [open, clearSelection]);

  if (mode === null) {
    return null;
  }

  const ariaLabel =
    mode === "finding" && findingModel !== null
      ? `Trace: ${prettifyReason(findingModel.reason)}`
      : `Decision: ${prettifyReason(decisionReason(decisionModel))}`;

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
        {mode === "finding" && findingModel !== null ? (
          <LiveTraceContent model={findingModel} onClose={clearSelection} />
        ) : null}
        {mode === "decision" && decisionModel !== null ? (
          <DecisionTraceContent model={decisionModel} onClose={clearSelection} />
        ) : null}
      </div>
    </div>
  );
}

/** The reason a decision-mode dialog names, or "" while no model is open yet (the
 *  dialog itself renders nothing in that case, so this only feeds the aria-label). */
function decisionReason(model: DecisionTraceViewModel | null): string {
  return model?.reason ?? "";
}

/** The header's entity chip, or null for an entity-less false decision. A caught
 *  decision always names one; a miss always names one too (an Attack always has an
 *  entity, unlike a finding). */
function decisionEntity(model: DecisionTraceViewModel): string | null {
  return model.entity;
}

/** T9's body: the header, then the Ingest+Normalize and Judge nodes. */
function LiveTraceContent({ model, onClose }: { model: TraceViewModel; onClose: () => void }) {
  return (
    <>
      <header className="trace-overlay-header">
        {model.entity !== undefined ? (
          <span className="trace-entity-chip">{model.entity}</span>
        ) : null}
        <span className="trace-reason">{prettifyReason(model.reason)}</span>
        <span className={`trace-state trace-state--${model.state}`}>{stateLabel(model.state)}</span>
        <span className="trace-time">{formatClock(model.at)}</span>
        <CloseButton onClose={onClose} />
      </header>
      <div className="trace-nodes">
        <section className="trace-node trace-node-ingest" aria-label="Ingest and Normalize">
          <h3 className="trace-node-title">Ingest + Normalize</h3>
          <TraceCardList cards={model.cards} />
        </section>
        <section className="trace-node trace-node-judge" aria-label="Judge">
          <h3 className="trace-node-title">Judge</h3>
          <WidgetList context={model.context} />
          <p className={`trace-verdict trace-verdict--${model.state}`}>
            {model.state === "hit" ? "finding raised" : "watching, no finding yet"}
          </p>
        </section>
      </div>
    </>
  );
}

/** T10's body: the header (outcome, entity, recorded-at), then either the evidence
 *  nodes (caught/false) or a solo missed panel (decision 12: no evidence pane). */
function DecisionTraceContent({
  model,
  onClose,
}: {
  model: DecisionTraceViewModel;
  onClose: () => void;
}) {
  const outcome = model.kind === "evidence" ? model.outcome : "missed";
  return (
    <>
      <header className="trace-overlay-header">
        {decisionEntity(model) !== null ? (
          <span className="trace-entity-chip">{decisionEntity(model)}</span>
        ) : null}
        <span className="trace-reason">{prettifyReason(model.reason)}</span>
        <span className={`trace-state trace-state--${outcome}`}>{outcomeLabel(outcome)}</span>
        <span className="trace-recorded-at">
          recorded at{" "}
          <span className="trace-recorded-at-time">{formatClock(model.resolvedAt)}</span> —
          snapshot, not live
        </span>
        <CloseButton onClose={onClose} />
      </header>
      {model.kind === "evidence" ? (
        <div className="trace-nodes">
          <section className="trace-node trace-node-cited" aria-label="Cited events">
            <h3 className="trace-node-title">Cited events</h3>
            <TraceCardList cards={model.cards} />
          </section>
          <section className="trace-node trace-node-judge" aria-label="Judge">
            <h3 className="trace-node-title">Judge</h3>
            <WidgetList context={model.context} />
          </section>
        </div>
      ) : (
        // The header above already carries the reason; this panel adds only what it
        // does not: the attack window (decision 12 — no evidence pane for a miss).
        <div className="trace-node trace-node-missed">
          <p className="trace-missed-window">
            Attack window: {formatClock(model.window.startTs)}–{formatClock(model.window.endTs)}
          </p>
        </div>
      )}
    </>
  );
}

function CloseButton({ onClose }: { onClose: () => void }) {
  // GH137-PLAN.md M2: badge-only (dispatch: false) — Escape already closes the trace
  // dialog via this component's own onKeyDown handler above.
  const { key } = useShortcut({
    scope: "trace",
    id: "close",
    onActivate: () => {},
    enabled: true,
  });
  return (
    <button
      type="button"
      className="trace-close"
      aria-label="Close trace"
      aria-keyshortcuts={key === undefined ? undefined : kbdGlyph(key)}
      onClick={onClose}
    >
      <span aria-hidden="true">×</span>
      {key !== undefined ? <Kbd shortcutKey={key} /> : null}
    </button>
  );
}

/** The cited-event cards, or a quiet empty note when there are none. */
function TraceCardList({ cards }: { cards: TraceCard[] }) {
  if (cards.length === 0) {
    return <p className="trace-node-empty">No cited events.</p>;
  }
  return (
    <ul className="trace-cards">
      {cards.map((card) => (
        <TraceCardItem key={card.id} card={card} />
      ))}
    </ul>
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
      <span className="trace-card-payload-label">Ingest</span>
      <pre className="trace-card-raw">{JSON.stringify(card.raw, null, 2)}</pre>
      <span className="trace-card-payload-label">Normalized</span>
      <pre className="trace-card-normalized">{JSON.stringify(card.normalized, null, 2)}</pre>
    </li>
  );
}
