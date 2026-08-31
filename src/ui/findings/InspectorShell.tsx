/**
 * The inspector shell (S3): a two-column layout with the raw stream on the left and
 * the findings on the right. The App renders it where the node canvas used to sit.
 * Growing it to the full three-column layout later is a container change, not a
 * panel rewrite.
 *
 * The shell owns the Esc-to-deselect listener. It sits on the shell container, so it
 * fires only for keydowns from within the shell (focus inside), and it yields when the
 * event was already handled (`defaultPrevented`). So it never steals Esc from the
 * editor or the intro overlay, both of which live outside the shell. This handles Esc
 * from ordinary focused shell content; the trace dialog (`TraceOverlay`, GH105-PLAN.md)
 * is no longer a descendant of the shell — `App.tsx` mounts it as a shell sibling
 * through `ModalHost`, so it handles its own Esc independently, never bubbling here.
 *
 * The shell renders `FindingsPanel` and passes it the findings-panel ref. In `App.tsx`
 * that ref is owned by `App` (lifted there, GH105-PLAN.md, so `TraceOverlay` can read it
 * as the finding-mode focus fallback, GH34-35-PLAN.md decision 14) and handed in here;
 * the prop is optional and defaults to a locally-owned ref, so a bare `<InspectorShell />`
 * (an isolated test) still works.
 *
 * `DecisionsPanel` (T10) and `TraceOverlay` are both siblings of the shell in `App.tsx`,
 * not children of it. `App.tsx` owns the decision-mode focus-fallback ref and hands it to
 * `DecisionsPanel` and `TraceOverlay` directly (GH105-PLAN.md), so this shell no longer
 * takes or forwards it.
 */
import { type RefObject, useRef } from "react";
import { useGameStore } from "../../game/store";
import { FxLayer } from "../fx/FxLayer";
import { LogPanel } from "../log/LogPanel";
import { FindingsPanel } from "./FindingsPanel";

interface InspectorShellProps {
  findingsPanelRef?: RefObject<HTMLElement | null>;
}

export function InspectorShell({
  findingsPanelRef: externalFindingsRef,
}: InspectorShellProps = {}) {
  const clearSelection = useGameStore((state) => state.clearSelection);
  const ownFindingsRef = useRef<HTMLElement>(null);
  const findingsPanelRef = externalFindingsRef ?? ownFindingsRef;

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
      <FxLayer />
    </section>
  );
}
