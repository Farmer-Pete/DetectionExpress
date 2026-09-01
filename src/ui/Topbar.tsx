/**
 * The app header, extracted from `App.tsx` (GH109-PLAN.md, GH118-PLAN.md): the
 * title, the slice tag, the embedded metro map's show/hide toggle, the two
 * side-panel openers, the "How this works" reopen button, and `<HireMe>`. It
 * consumes `reopenRef`/`onReopen` from `useIntroOverlay` the same way it consumes
 * `onOpenChaos`/`onOpenAlgorithm` from `useSidePanel`, rather than owning either
 * itself, so `App` wires both hooks to this component the same way it wires them to
 * `ModalHost`'s overlay slot.
 *
 * GH117 Part F: there is only one view now (the pipeline HUD with the metro map
 * embedded in it), so the map toggle no longer swaps between two loops — it just
 * shows or hides the map region in place, via `mapShown`. That also means the
 * chaos-ladder and Algorithm openers (GH118-PLAN.md) are unconditional: with a
 * single view there is no mode where the side panel they open would have nowhere to
 * land. `chaosButtonRef`/`algorithmButtonRef` are exposed the same way `reopenRef`
 * is, so App can hand them to the side panel as its focus-restore fallback for the
 * intro path, where the button that opened the panel (the intro's own) is already
 * gone by the time the panel closes.
 */
import type { RefObject } from "react";
import { hireMe } from "./content/narrative";
import { HireMe } from "./HireMe";

interface TopbarProps {
  mapShown: boolean;
  onToggleMap: () => void;
  reopenRef: RefObject<HTMLButtonElement | null>;
  onReopen: () => void;
  onOpenChaos: () => void;
  onOpenAlgorithm: () => void;
  chaosButtonRef: RefObject<HTMLButtonElement | null>;
  algorithmButtonRef: RefObject<HTMLButtonElement | null>;
}

export function Topbar({
  mapShown,
  onToggleMap,
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
        <button type="button" className="view-toggle" onClick={onToggleMap}>
          {mapShown ? "Hide metro view" : "Show metro view"}
        </button>
        <button type="button" ref={reopenRef} className="topbar-reopen" onClick={onReopen}>
          How this works
        </button>
        <HireMe copy={hireMe} />
      </div>
    </header>
  );
}
