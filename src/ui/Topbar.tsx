/**
 * The app header, extracted from `App.tsx` (GH109-PLAN.md): the title, the slice
 * tag, the Metro/Pipeline view toggle, the "How this works" reopen button, and
 * `<HireMe>`. It consumes `reopenRef` and `onReopen` from `useIntroOverlay` rather
 * than owning them itself, so `App` wires the intro hook to this component the same
 * way it wires it to `ModalHost`'s overlay slot.
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
}

export function Topbar({ view, onToggleView, reopenRef, onReopen }: TopbarProps) {
  return (
    <header className="topbar">
      <h1>Detection Express</h1>
      <span className="slice-tag">Observe the Engine, then cause chaos</span>
      <div className="topbar-actions">
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
