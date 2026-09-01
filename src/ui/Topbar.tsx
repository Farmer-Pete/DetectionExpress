/**
 * `Topbar` is the extracted header (GH109-PLAN.md): title, slice tag, the embedded
 * metro map's show/hide toggle, the "How this works" reopen button, and Hire Me. It
 * consumes `reopenRef`/`onReopen` from `useIntroOverlay` rather than owning them, so
 * these tests stub both.
 *
 * GH117 Part F: there is only one view now (the pipeline HUD with the metro map
 * embedded in it), so the toggle no longer swaps between two loops — it just shows or
 * hides the map region in place, via `mapShown`.
 */
import type { RefObject } from "react";
import { hireMe } from "./content/narrative";
import { HireMe } from "./HireMe";

interface TopbarProps {
  mapShown: boolean;
  onToggleMap: () => void;
  reopenRef: RefObject<HTMLButtonElement | null>;
  onReopen: () => void;
}

export function Topbar({ mapShown, onToggleMap, reopenRef, onReopen }: TopbarProps) {
  return (
    <header className="topbar">
      <h1>Detection Express</h1>
      <span className="slice-tag">Observe the Engine, then cause chaos</span>
      <div className="topbar-actions">
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
