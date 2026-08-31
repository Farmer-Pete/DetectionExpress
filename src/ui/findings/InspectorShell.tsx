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
 * renders it, and `TraceOverlay` reads it as the focus fallback (GH34-35-PLAN.md
 * decision 14) for when reconciliation evicts a trace's trigger row.
 */
import { useRef } from "react";
import { useGameStore } from "../../game/store";
import { LogPanel } from "../log/LogPanel";
import { FindingsPanel } from "./FindingsPanel";
import { TraceOverlay } from "./TraceOverlay";

export function InspectorShell() {
  const clearSelection = useGameStore((state) => state.clearSelection);
  const findingsPanelRef = useRef<HTMLElement>(null);

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
      <TraceOverlay fallbackFocusRef={findingsPanelRef} />
    </section>
  );
}
