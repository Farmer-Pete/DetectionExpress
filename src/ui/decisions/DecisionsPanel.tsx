/**
 * The decisions panel (T10, GH35): a newest-first strip of caught / missed / false
 * decisions, mounted directly under `InspectorShell` in `App.tsx`. Rows are real
 * `<button>` elements with `aria-pressed`, mirroring `FindingsPanel`'s pattern:
 * click, Enter, and Space all select, and focus stays visible. A row click toggles
 * the selection through the store's `selectDecision`, which also clears any live
 * finding selection (the trace dialog is single).
 */
import { useGameStore } from "../../game/store";
import { formatClock } from "../log/formatters";
import { buildDecisionRows, type DecisionRow } from "./view-model";

export function DecisionsPanel() {
  const decisions = useGameStore((state) => state.snapshot.decisions);
  const decisionSelection = useGameStore((state) => state.decisionSelection);
  const selectDecision = useGameStore((state) => state.selectDecision);

  const rows = buildDecisionRows(decisions);
  const selectedSeq = decisionSelection?.seq ?? null;

  return (
    <section className="decisions-panel" aria-label="Decisions">
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
        onClick={() => onSelect(row.seq)}
      >
        <span className={`decisions-outcome decisions-outcome--${row.outcome}`}>{row.outcome}</span>
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
