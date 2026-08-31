/**
 * The findings panel. It reads the live findings and the selection from the store,
 * builds the ranked, grouped view each render, and renders one card per group. Rows
 * are real `<button>` elements with `aria-pressed`, so click, Enter, and Space all
 * select and focus stays visible. The panel owns select and deselect: a row click
 * toggles the selection, and a click on the empty panel background clears it.
 *
 * The background-clear listener lives on the document, not on the panel element, so
 * the panel div stays plain and presentational. It uses IntroOverlay's document-level
 * listener technique, but with a stricter check: it clears only when the click target
 * is the bare panel background itself, never a row, a card, or anything outside.
 *
 * `buildFindingGroups` runs each render. The live set is small and bounded, and the
 * sim publishes a fresh frozen array every tick, so a `useMemo` on that reference
 * would recompute every tick anyway. So there is no memo. (See GH33-PLAN.md.)
 */
import { useEffect, useRef, useState } from "react";
import { useGameStore } from "../../game/store";
import {
  buildFindingGroups,
  countActiveHits,
  type FindingGroup,
  type FindingRow,
  VISIBLE_CAP,
} from "./view-model";

export function FindingsPanel() {
  const findings = useGameStore((state) => state.snapshot.findings);
  const selection = useGameStore((state) => state.selection);
  const selectFinding = useGameStore((state) => state.selectFinding);
  const clearSelection = useGameStore((state) => state.clearSelection);
  const [expanded, setExpanded] = useState(false);
  const panelRef = useRef<HTMLElement>(null);

  // A click that lands on the bare panel background, not on a card or a row, clears the
  // selection. The listener sits on the document and checks the exact target, so the
  // panel element stays presentational with no click handler of its own.
  useEffect(() => {
    const onDocumentClick = (event: MouseEvent): void => {
      if (event.target === panelRef.current) {
        clearSelection();
      }
    };
    document.addEventListener("click", onDocumentClick);
    return () => document.removeEventListener("click", onDocumentClick);
  }, [clearSelection]);

  const selectedSeq = selection?.seq ?? null;
  const { groups, hiddenCount } = buildFindingGroups(findings, selectedSeq);
  const visible = expanded ? groups : groups.slice(0, VISIBLE_CAP);
  const { count: activeCount, urgent } = countActiveHits(findings);
  // Static outside any reduced-motion guard: the threat border reads even with
  // motion off (GH38-PLAN.md decision 4). The CSS layers the `urgentborder`
  // pulse on top of it, gated behind `prefers-reduced-motion: no-preference`.
  const panelClass = urgent ? "findings-panel urgent" : "findings-panel";

  return (
    <section ref={panelRef} className={panelClass} aria-label="Findings">
      {findings.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          <div className="findings-header">
            <span className="findings-active">⚠ {activeCount} active</span>
          </div>
          <ul className="findings-list">
            {visible.map((group) => (
              <FindingGroupCard
                key={group.key}
                group={group}
                selectedSeq={selectedSeq}
                onSelect={selectFinding}
              />
            ))}
          </ul>
          {hiddenCount > 0 && !expanded ? (
            <button type="button" className="findings-more" onClick={() => setExpanded(true)}>
              +{hiddenCount} more
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}

interface GroupCardProps {
  group: FindingGroup;
  selectedSeq: number | null;
  onSelect: (seq: number) => void;
}

/** One entity's card: an entity chip, an agreement badge, and its rows. */
function FindingGroupCard({ group, selectedSeq, onSelect }: GroupCardProps) {
  const selected = group.rows.some((row) => row.seq === selectedSeq);
  return (
    <li className={selected ? "findings-group is-selected" : "findings-group"}>
      <div className="findings-group-head">
        {group.entity !== null ? (
          <span className="findings-entity-chip">
            {group.entityKind !== undefined ? (
              <>
                <span className="findings-entity-kind">{group.entityKind}</span>
                {/* A spoken separator so a screen reader does not run the kind and the
                    value together, e.g. "account acct-7". */}
                <span className="visually-hidden">: </span>
              </>
            ) : null}
            <span className="findings-entity-value">{group.entity}</span>
          </span>
        ) : (
          <span className="findings-entity-chip findings-entity-chip--solo">Unresolved</span>
        )}
        {group.agreement ? (
          <span className="findings-agreement" title="Two hunts agree on this entity">
            Agreement
            {/* The visible word carries the signal; this spells it out for a screen
                reader, since a title tooltip is not reliably announced. */}
            <span className="visually-hidden"> — two hunts corroborate this entity</span>
          </span>
        ) : null}
      </div>
      <ul className="findings-rows">
        {group.rows.map((row) => (
          <FindingRowItem
            key={row.seq}
            row={row}
            selected={row.seq === selectedSeq}
            onSelect={onSelect}
          />
        ))}
      </ul>
    </li>
  );
}

interface RowProps {
  row: FindingRow;
  selected: boolean;
  onSelect: (seq: number) => void;
}

/** One finding row: a state chip, its label, and its cited count. */
function FindingRowItem({ row, selected, onSelect }: RowProps) {
  return (
    <li>
      <button
        type="button"
        className={selected ? "findings-row is-selected" : "findings-row"}
        aria-pressed={selected}
        onClick={() => onSelect(row.seq)}
      >
        <span
          className={
            row.state === "hit"
              ? "findings-state findings-state--hit"
              : "findings-state findings-state--watch"
          }
        >
          {row.state}
        </span>
        <span className="findings-label">{row.label}</span>
        <span className="findings-cited">
          {row.citedCount}
          <span className="visually-hidden"> cited events</span>
        </span>
      </button>
    </li>
  );
}

/** The quiet copy shown while no finding is open. */
function EmptyState() {
  return (
    <div className="findings-empty">
      <p className="findings-empty-title">No findings yet</p>
      <p className="findings-empty-note">The Engine raises findings here as it spots a pattern.</p>
    </div>
  );
}
