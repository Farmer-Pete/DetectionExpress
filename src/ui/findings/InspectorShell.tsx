/**
 * The inspector shell (S3): a two-column layout with the raw stream on the left and
 * the findings on the right, plus the trace dialog (T9). The App renders it where the
 * node canvas used to sit. Growing it to the full three-column layout later is a
 * container change, not a panel rewrite.
 *
 * The shell owns the Esc-to-deselect listener. It sits on the shell container, so it
 * fires only for keydowns from within the shell (focus inside), and it yields when the
 * event was already handled (`defaultPrevented`). So it never steals Esc from the
 * editor or the intro overlay, both of which live outside the shell. `TraceOverlay`
 * preempts it in practice: it calls `preventDefault` on its own Esc handler, so this
 * listener only ever fires a redundant, harmless `clearSelection` past that point.
 *
 * The shell owns the findings-panel ref and hands it to both children: `FindingsPanel`
 * renders it, and `TraceOverlay` reads it as the finding-mode focus fallback
 * (GH34-35-PLAN.md decision 14) for when reconciliation evicts a trace's trigger row.
 *
 * `DecisionsPanel` (T10) is a sibling of the shell in `App.tsx`, not a child of it, so
 * its ref cannot be owned here the same way: `App.tsx` owns it and passes it down as
 * `decisionsPanelRef`, which this shell forwards to `TraceOverlay` as the decision-mode
 * focus fallback. Optional, defaulting to a locally-owned ref, so a bare
 * `<InspectorShell />` (an isolated test, with no `DecisionsPanel` mounted) still works.
 */
import { type RefObject, useRef } from "react";
import { useGameStore } from "../../game/store";
import { LogPanel } from "../log/LogPanel";
import { FindingsPanel } from "./FindingsPanel";
import { TraceOverlay } from "./TraceOverlay";

interface InspectorShellProps {
  decisionsPanelRef?: RefObject<HTMLElement | null>;
}

export function InspectorShell({
  decisionsPanelRef: externalDecisionsRef,
}: InspectorShellProps = {}) {
  const clearSelection = useGameStore((state) => state.clearSelection);
  const findingsPanelRef = useRef<HTMLElement>(null);
  const ownDecisionsRef = useRef<HTMLElement>(null);
  const decisionsPanelRef = externalDecisionsRef ?? ownDecisionsRef;

  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>): void => {
    if (event.key === "Escape" && !event.defaultPrevented) {
      clearSelection();
    }
  };

  return (
    <section className="inspector-shell" aria-label="Inspector" onKeyDown={onKeyDown}>
      <div className="inspector-stream">
        <LogPanel />
      </div>
      <FindingsPanel panelRef={findingsPanelRef} />
      <TraceOverlay
        fallbackFocusRef={findingsPanelRef}
        decisionsFallbackFocusRef={decisionsPanelRef}
      />
    </section>
  );
}
