/**
 * The decisions panel (T10, GH35): a newest-first strip of caught / missed / false
 * decisions, mounted directly under `InspectorShell` in `App.tsx`. Rows are real
 * `<button>` elements with `aria-pressed`, mirroring `FindingsPanel`'s pattern:
 * click, Enter, and Space all select, and focus stays visible. A row click toggles
 * the selection through the store's `selectDecision`, which also clears any live
 * finding selection (the trace dialog is single).
 *
 * The panel carries `tabIndex={-1}` and accepts an optional external ref (the trace
 * dialog's decision-mode focus fallback, GH34-35-PLAN.md decision 14): when a
 * decision's trigger row was evicted by reconciliation (the cap, or a run restart),
 * `TraceOverlay` focuses this container instead. `App.tsx` owns the shared ref and
 * hands it to both this panel and `InspectorShell`.
 */
import type { RefObject } from "react";
import { useGameStore } from "../../game/store";
import { formatClock } from "../log/formatters";
import { buildDecisionRows, type DecisionRow, outcomeLabel } from "./view-model";

interface DecisionsPanelProps {
  /** The focus-fallback ref TraceOverlay reads. Defaults to a locally-owned ref. */
  panelRef?: RefObject<HTMLElement | null>;
}

export function DecisionsPanel({ panelRef }: DecisionsPanelProps = {}) {
  const decisions = useGameStore((state) => state.snapshot.decisions);
  const decisionSelection = useGameStore((state) => state.decisionSelection);
  const selectDecision = useGameStore((state) => state.selectDecision);

  const rows = buildDecisionRows(decisions);
  const selectedSeq = decisionSelection?.seq ?? null;

  return (
    <section ref={panelRef} className="decisions-panel" aria-label="Decisions" tabIndex={-1}>
      {rows.length === 0 ? (
        <EmptyState />
      ) : (
        <ul className="decisions-list">
          {rows.map((row) => (
            <DecisionRowItem
              key={row.seq}
              row={row}
              selected={row.seq === selectedSeq}
              onSelect={selectDecision}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

interface RowProps {
  row: DecisionRow;
  selected: boolean;
  onSelect: (seq: number) => void;
}

/** One decision row: an outcome tag, an optional entity chip, the reason, and the time. */
function DecisionRowItem({ row, selected, onSelect }: RowProps) {
  return (
    <li>
      <button
        type="button"
        className={selected ? "decisions-row is-selected" : "decisions-row"}
        aria-pressed={selected}
        onClick={(event) => {
          // Safari does not focus a clicked <button> by default, unlike Chrome and
          // Firefox. TraceOverlay's open-effect captures `document.activeElement` as
          // the trigger to refocus on close (GH34-35-PLAN.md decision 14), so an
          // unfocused row there would break that restore. Force the focus explicitly,
          // independent of the browser's own click-to-focus behavior.
          event.currentTarget.focus();
          onSelect(row.seq);
        }}
      >
        <span className={`decisions-outcome decisions-outcome--${row.outcome}`}>
          {outcomeLabel(row.outcome)}
        </span>
        {row.entity !== null ? <span className="decisions-entity">{row.entity}</span> : null}
        <span className="decisions-reason">{row.reason}</span>
        <span className="decisions-time">{formatClock(row.time)}</span>
      </button>
    </li>
  );
}

/** The quiet copy shown while no decision has resolved yet. */
function EmptyState() {
  return (
    <div className="decisions-empty">
      <p className="decisions-empty-title">No decisions yet</p>
      <p className="decisions-empty-note">
        Caught, missed, and false alerts land here as the Engine judges them.
      </p>
    </div>
  );
}
