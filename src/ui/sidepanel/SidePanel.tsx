/**
 * The side panel: a right-edge overlay that carries the two panels the pipeline view
 * used to stack below the fold (GH118-PLAN.md) — the chaos ladder and the Algorithm
 * editor — behind an accessible tab strip. Purely presentational: `use-side-panel.tsx`
 * owns `open`/`tab`, the pause protocol, and the Apply-on-success wiring; this
 * component only renders the given tab and reports clicks and key presses back up.
 *
 * It is a real modal dialog, styled on `IntroOverlay`'s and `TraceOverlay`'s pattern
 * (`src/ui/focus.ts`): `role="dialog"`, `aria-modal="true"`, its own dim backdrop that
 * dismisses on an outside click (a gesture STARTING inside the dialog never does, even
 * if it ends on the backdrop — `installOutsidePointerDismiss`), Escape dismisses too,
 * and Tab/Shift+Tab wrap at the dialog's edges (`trapTab`). Since the parent only
 * mounts this component while `open` is true, its own mount/unmount lifecycle IS the
 * open/close lifecycle: focus moves onto the first control on mount, and restores to
 * whatever held focus at that moment on unmount — falling back to `fallbackFocusRef`
 * when that trigger is gone, or was never real to begin with.
 *
 * "Never real" covers the intro path (App.tsx): its "Cause chaos"/"Edit the Engine"
 * close the intro, and only a LATER effect opens this panel once the intro has
 * actually unmounted — a separate commit, not the same one. By then the intro's
 * button is already gone from the document, so the DOM has already retargeted focus
 * to `document.body` on its own; `document.activeElement` at this component's own
 * mount is `body`, not the button that "caused" the open. `body` is always
 * `.isConnected`, so treating it as a real trigger would restore focus to the page
 * body, silently skipping `fallbackFocusRef` — so it is excluded up front, the same
 * as a trigger that is not an `HTMLElement` at all.
 *
 * The tab strip follows the WAI-ARIA tabs pattern: `role="tablist"` / `"tab"` /
 * `"tabpanel"`, `aria-selected`, each tab's `aria-controls` names its panel and the
 * panel's `aria-labelledby` names its tab, and ArrowRight/ArrowLeft both select and
 * move DOM focus to the adjacent tab (roving tabindex: only the active tab is in the
 * Tab order). BOTH tabpanels render at all times, the inactive one carrying `hidden`.
 * That keeps every tab's `aria-controls` pointing at an element that exists, and a
 * `hidden` subtree is excluded from `focusableControls`, so the off-screen panel's
 * controls never enter the focus trap.
 */
import { type RefObject, useEffect, useRef } from "react";
import { defaultEntry } from "../../game/registry";
import { AlgorithmEditor } from "../AlgorithmEditor";
import { ChaosLadder } from "../ChaosLadder";
import { chaosLevels, liveScenarioFrom } from "../content/narrative";
import { focusableControls, installOutsidePointerDismiss, trapTab } from "../focus";

export type SidePanelTab = "chaos" | "algorithm";

const liveScenario = liveScenarioFrom(defaultEntry);

const TABS: ReadonlyArray<{ id: SidePanelTab; label: string }> = [
  { id: "chaos", label: "Chaos ladder" },
  { id: "algorithm", label: "Algorithm" },
];

export interface SidePanelProps {
  /** The active tab. */
  tab: SidePanelTab;
  /** Called on a tab click or an arrow-key move. */
  onSelectTab: (tab: SidePanelTab) => void;
  /** Dismiss: Escape, the backdrop, and the close button all call this. */
  onClose: () => void;
  /** The Algorithm tab's Apply, wired to `AlgorithmEditor`'s `onRun`. */
  onApply: () => void;
  /** Focus-restore fallback for when the trigger element is gone on unmount (decision
   *  14's TraceOverlay pattern), e.g. the intro path in a later stage. */
  fallbackFocusRef?: RefObject<HTMLElement | null> | undefined;
}

export function SidePanel({
  tab,
  onSelectTab,
  onClose,
  onApply,
  fallbackFocusRef,
}: SidePanelProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const tablistRef = useRef<HTMLDivElement>(null);

  // Move focus into the dialog on mount, onto its first control; restore it on
  // unmount to whatever triggered the open, or the fallback if that trigger is gone.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally mount/unmount-only (F001, mirrors TraceOverlay.tsx's own focus effect); the parent only ever mounts this component while `open` is true, so its mount/unmount lifecycle IS the open/close lifecycle, and re-running this on a `fallbackFocusRef` identity change would move focus mid-session.
  useEffect(() => {
    const dialog = dialogRef.current;
    const active = document.activeElement;
    // `body` is excluded up front (see the module doc): it is never a meaningful
    // trigger, just where focus lands once nothing else claims it.
    const trigger = active instanceof HTMLElement && active !== document.body ? active : null;
    if (dialog !== null) {
      focusableControls(dialog)[0]?.focus();
    }
    return () => {
      if (trigger?.isConnected) {
        trigger.focus();
      } else {
        fallbackFocusRef?.current?.focus();
      }
    };
  }, []);

  // A gesture outside the dialog, on the backdrop scrim, dismisses it. See
  // `installOutsidePointerDismiss` for why only a gesture that both starts AND ends
  // outside counts.
  useEffect(() => {
    return installOutsidePointerDismiss(dialogRef, onClose);
  }, [onClose]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    const dialog = dialogRef.current;
    if (dialog === null) {
      return;
    }
    trapTab(dialog, event);
  };

  const onTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") {
      return;
    }
    event.preventDefault();
    const currentIndex = TABS.findIndex((entry) => entry.id === tab);
    const delta = event.key === "ArrowRight" ? 1 : -1;
    const next = TABS[(currentIndex + delta + TABS.length) % TABS.length];
    if (next === undefined) {
      return;
    }
    onSelectTab(next.id);
    tablistRef.current?.querySelector<HTMLButtonElement>(`#sidepanel-tab-${next.id}`)?.focus();
  };

  return (
    <div className="sidepanel-backdrop">
      <div
        ref={dialogRef}
        className="sidepanel"
        role="dialog"
        aria-modal="true"
        aria-label="Side panel"
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <div className="sidepanel-header">
          <div
            className="sidepanel-tablist"
            role="tablist"
            aria-label="Side panel tabs"
            ref={tablistRef}
          >
            {TABS.map((entry) => {
              const active = entry.id === tab;
              return (
                <button
                  key={entry.id}
                  type="button"
                  role="tab"
                  id={`sidepanel-tab-${entry.id}`}
                  aria-selected={active}
                  aria-controls={`sidepanel-tabpanel-${entry.id}`}
                  tabIndex={active ? 0 : -1}
                  className={active ? "sidepanel-tab sidepanel-tab-active" : "sidepanel-tab"}
                  onClick={() => onSelectTab(entry.id)}
                  onKeyDown={onTabKeyDown}
                >
                  {entry.label}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            className="sidepanel-close"
            aria-label="Close panel"
            onClick={onClose}
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>
        <div
          role="tabpanel"
          id="sidepanel-tabpanel-chaos"
          aria-labelledby="sidepanel-tab-chaos"
          className="sidepanel-body"
          hidden={tab !== "chaos"}
        >
          <ChaosLadder levels={chaosLevels} liveScenario={liveScenario} />
        </div>
        <div
          role="tabpanel"
          id="sidepanel-tabpanel-algorithm"
          aria-labelledby="sidepanel-tab-algorithm"
          className="sidepanel-body"
          hidden={tab !== "algorithm"}
        >
          <AlgorithmEditor onRun={onApply} />
        </div>
      </div>
    </div>
  );
}
