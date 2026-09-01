/**
 * The app header, extracted from `App.tsx` (GH109-PLAN.md): the title, the slice
 * tag, the Metro/Pipeline view toggle, the "How this works" reopen button, the two
 * side-panel openers, and `<HireMe>`. It consumes `reopenRef`/`onReopen` from
 * `useIntroOverlay` the same way it consumes `onOpenChaos`/`onOpenAlgorithm` from
 * `useSidePanel`, rather than owning either itself, so `App` wires both hooks to
 * this component the same way it wires them to `ModalHost`'s overlay slot.
 *
 * The chaos-ladder and Algorithm openers (GH118-PLAN.md) show only in the pipeline
 * view: the side panel they open holds pipeline-only content, and the metro view has
 * nowhere for it to land. `chaosButtonRef`/`algorithmButtonRef` are exposed the same
 * way `reopenRef` is, so App can hand them to the side panel as its focus-restore
 * fallback for the intro path, where the button that opened the panel (the intro's
 * own) is already gone by the time the panel closes.
 */
import type { RefObject } from "react";
import { hireMe } from "./content/narrative";
import { HireMe } from "./HireMe";
import type { View } from "./view";

interface TopbarProps {
  view: View;
  onToggleView: () => void;
  reopenRef: RefObject<HTMLButtonElement | null>;
  onReopen: () => void;
  onOpenChaos: () => void;
  onOpenAlgorithm: () => void;
  chaosButtonRef: RefObject<HTMLButtonElement | null>;
  algorithmButtonRef: RefObject<HTMLButtonElement | null>;
}

export function Topbar({
  view,
  onToggleView,
  reopenRef,
  onReopen,
  onOpenChaos,
  onOpenAlgorithm,
  chaosButtonRef,
  algorithmButtonRef,
}: TopbarProps) {
  return (
    <header className="topbar">
      <h1>Detection Express</h1>
      <span className="slice-tag">Observe the Engine, then cause chaos</span>
      <div className="topbar-actions">
        {view === "pipeline" ? (
          <>
            <button
              type="button"
              ref={chaosButtonRef}
              className="topbar-panel-open"
              onClick={onOpenChaos}
            >
              Chaos ladder
            </button>
            <button
              type="button"
              ref={algorithmButtonRef}
              className="topbar-panel-open"
              onClick={onOpenAlgorithm}
            >
              Algorithm
            </button>
          </>
        ) : null}
        <button type="button" className="view-toggle" onClick={onToggleView}>
          {view === "pipeline" ? "Metro view" : "Pipeline view"}
        </button>
        <button type="button" ref={reopenRef} className="topbar-reopen" onClick={onReopen}>
          How this works
        </button>
        <HireMe copy={hireMe} />
      </div>
    </header>
  );
}
