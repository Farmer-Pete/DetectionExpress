/**
 * The side panel: a right-edge overlay that carries the panels the pipeline view
 * used to stack below the fold (GH118-PLAN.md) — the chaos ladder and the
 * Algorithm editor — behind an accessible tab strip. Purely presentational: `use-side-panel.tsx`
 * owns `open`/`tab`, the pause protocol, and the Apply-on-success wiring; this
 * component only renders the given tab and reports clicks and key presses back up.
 *
 * The chaos ladder's own live values (GH126-PLAN.md M3b) are the one exception: this
 * is the ladder's mount site, so it reads the selected level, the live chaos phase,
 * and the `setChaosLevel` action straight off the store, one narrow selector per
 * value (ARCHITECTURE.md), and hands them to `ChaosLadder` as props. `ChaosLadder`
 * itself stays presentational and store-free.
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
 * Tab order). ALL THREE tabpanels render at all times, the inactive ones carrying
 * `hidden`. That keeps every tab's `aria-controls` pointing at an element that
 * exists, and a `hidden` subtree is excluded from `focusableControls`, so an
 * off-screen panel's controls never enter the focus trap.
 *
 * GH132-PLAN.md M1 (design revision, "SUPERSEDES the popup menu"): a third tab,
 * "Options", holds the two actions that used to live in the popup hamburger menu
 * and the Topbar's standalone reopen button — the metro-view toggle and the tour
 * button. The tab strip itself is restyled in `src/index.css` to read as real tabs
 * (the active tab's underline joins the panel body's own border), not detached pill
 * buttons; the ARIA above is unchanged.
 *
 * GH132-PLAN.md M2: the Options tab's second button is now "Retake tour", wired to
 * `onStartTour` (`App.tsx`'s `use-tour`), replacing M1's "How this works" reopen of
 * the intro overlay. Same wiring shape as the button it replaces: both the panel and
 * a subsequent overlay-ish action need the panel gone first, so `App.tsx` still
 * closes this panel before acting, on `sidePanel.open` actually going false.
 *
 * GH132-PLAN.md M2, "Tour redesign: 8 steps, drawer-open step 2" — "Step 2
 * drawer-open: Codex fixes (accepted)" rule 3: the tour's step 2 opens THIS panel
 * itself, mid-tour, through a second, non-modal `mode` (`use-side-panel.tsx`'s
 * `tourOpen`/`openForTour`/`closeForTour`, distinct from `open`). driver.js is
 * already running its own focus trap and Escape handling for the tour popover, so
 * this component's own modal machinery would fight it. `mode="tour"` therefore
 * drops every piece of that machinery instead of layering a second one on top:
 * no `role="dialog"`/`aria-modal` (a labelled `role="region"` instead), no
 * mount-focus or unmount-focus-restore effect, no outside-pointer-dismiss, no
 * Escape-close, no Tab trap — driver.js owns focus and Escape while the tour
 * drives this panel. The tabs, the close button, and (via `ChaosLadder`'s own
 * `disabled` prop) every chaos level are also semantically disabled: a native
 * `disabled` on each control, not just a CSS/`disableActiveInteraction` dimming,
 * so the narrated ladder can never be clicked through by a stray keyboard or AT
 * interaction. `mode` defaults to `"modal"`, so every pre-existing call site
 * (and every test above this comment) is unaffected.
 */
import { type RefObject, useEffect, useRef } from "react";
import { defaultEntry } from "../../game/registry";
import { useGameStore } from "../../game/store";
import { AlgorithmEditor } from "../AlgorithmEditor";
import { ChaosLadder } from "../ChaosLadder";
import { chaosLevels, liveScenarioFrom } from "../content/narrative";
import { focusableControls, installOutsidePointerDismiss, trapTab } from "../focus";
import { Kbd } from "../shortcuts/Kbd";
import { kbdGlyph } from "../shortcuts/shortcuts.data";
import { useShortcut } from "../shortcuts/use-shortcut";

export type SidePanelTab = "chaos" | "algorithm" | "options";

/** `"modal"` (default): the pre-existing real dialog, described above. `"tour"`
 *  (GH132-PLAN.md M2): the panel renders open, but as a non-modal region driver.js
 *  narrates over — see the module doc. */
type SidePanelMode = "modal" | "tour";

const liveScenario = liveScenarioFrom(defaultEntry);

const TABS: ReadonlyArray<{ id: SidePanelTab; label: string }> = [
  { id: "chaos", label: "Chaos ladder" },
  { id: "algorithm", label: "Algorithm" },
  { id: "options", label: "Options" },
];

export interface SidePanelProps {
  /** `"modal"` (default) or `"tour"` (GH132-PLAN.md M2) — see the module doc. */
  mode?: SidePanelMode | undefined;
  /** The active tab. */
  tab: SidePanelTab;
  /** Called on a tab click or an arrow-key move. */
  onSelectTab: (tab: SidePanelTab) => void;
  /** Dismiss: Escape, the backdrop, and the close button all call this. */
  onClose: () => void;
  /** The Algorithm tab's Apply, wired to `AlgorithmEditor`'s `onRun`. */
  onApply: () => void;
  /** Whether the embedded metro map region currently shows, so the Options tab's
   *  toggle button can label itself "Hide"/"Show". */
  mapShown: boolean;
  /** Flips `mapShown`, wired to the Options tab's metro-view toggle button. */
  onToggleMap: () => void;
  /** Starts the guided tour, wired to the Options tab's "Retake tour" button
   *  (GH132-PLAN.md M2, replacing M1's "How this works" intro-reopen). The panel is
   *  a modal and the tour needs the shell live (its targets, including the
   *  hamburger, sit inside `.app-shell`), so `App.tsx` closes this panel first, then
   *  starts the tour once it has actually unmounted. */
  onStartTour: () => void;
  /** Focus-restore fallback for when the trigger element is gone on unmount (decision
   *  14's TraceOverlay pattern), e.g. the intro path in a later stage. */
  fallbackFocusRef?: RefObject<HTMLElement | null> | undefined;
}

export function SidePanel({
  mode = "modal",
  tab,
  onSelectTab,
  onClose,
  onApply,
  mapShown,
  onToggleMap,
  onStartTour,
  fallbackFocusRef,
}: SidePanelProps) {
  const isTour = mode === "tour";
  const dialogRef = useRef<HTMLDivElement>(null);
  const tablistRef = useRef<HTMLDivElement>(null);

  // GH137-PLAN.md M2: the Close button is one physical control shared by all three
  // tabs, so its badge-only Escape entry tracks whichever `sidepanel:*` scope is
  // currently active. TypeScript narrows this template literal to the `Scope` union
  // via `tab`'s own `SidePanelTab` union.
  const closeScope = `sidepanel:${tab}` as const;
  const { key: closeKey } = useShortcut({
    scope: closeScope,
    id: "close",
    onActivate: () => {},
    enabled: true,
  });
  // The Options tab's two command buttons: always mounted (only their `hidden`
  // tabpanel ancestor changes), so `enabled` mirrors that real visibility.
  const { key: retakeTourKey } = useShortcut({
    scope: "sidepanel:options",
    id: "retake-tour",
    onActivate: onStartTour,
    enabled: tab === "options",
  });
  const { key: mapToggleKey } = useShortcut({
    scope: "sidepanel:options",
    id: "map-toggle",
    onActivate: onToggleMap,
    enabled: tab === "options",
  });

  // The chaos ladder's live wiring (GH126-PLAN.md M3b): one narrow selector per
  // value (ARCHITECTURE.md), read here since this is the ladder's mount site.
  // `ChaosLadder` itself stays presentational, taking these as props.
  const chaosLevel = useGameStore((state) => state.chaosLevel);
  const chaosPhase = useGameStore((state) => state.snapshot.chaosPhase);
  const setChaosLevel = useGameStore((state) => state.setChaosLevel);

  // Move focus into the dialog on mount, onto its first control; restore it on
  // unmount to whatever triggered the open, or the fallback if that trigger is gone.
  // Skipped entirely in tour mode (GH132-PLAN.md M2, "Codex fixes" rule 3):
  // driver.js owns focus while it drives this panel, so a competing auto-focus or
  // focus-restore here would fight it. `mode` is fixed for a given mount (`open`
  // and `tourOpen` are mutually exclusive, so a mounted instance is always
  // entirely one or the other), so reading `isTour` here without listing it as a
  // dependency is safe.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally mount/unmount-only (F001, mirrors TraceOverlay.tsx's own focus effect); the parent only ever mounts this component while `open` is true, so its mount/unmount lifecycle IS the open/close lifecycle, and re-running this on a `fallbackFocusRef` identity change would move focus mid-session.
  useEffect(() => {
    if (isTour) {
      return;
    }
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
  // outside counts. Skipped in tour mode: outside clicks never close a tour-opened
  // panel (rule 3 above) — driver.js's own overlay owns dismissal while it drives.
  useEffect(() => {
    if (isTour) {
      return;
    }
    return installOutsidePointerDismiss(dialogRef, onClose);
  }, [onClose, isTour]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (isTour) {
      return; // driver.js owns Escape and Tab while the tour drives this panel
    }
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

  // In tour mode the panel is a labelled NON-modal region (Codex fixes rule 3): no
  // role="dialog", no aria-modal, and no Escape/keydown handling (driver owns Escape
  // and focus). Spread the mode-specific a11y props so each shape is statically valid.
  const surfaceProps = isTour
    ? { role: "region" as const, "aria-label": "Side panel" }
    : {
        role: "dialog" as const,
        "aria-modal": true as const,
        "aria-label": "Side panel",
        onKeyDown,
      };
  return (
    <div className={isTour ? "sidepanel-backdrop sidepanel-backdrop-tour" : "sidepanel-backdrop"}>
      <div ref={dialogRef} className="sidepanel" tabIndex={-1} {...surfaceProps}>
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
                  disabled={isTour}
                  className={active ? "sidepanel-tab sidepanel-tab-active" : "sidepanel-tab"}
                  onClick={() => {
                    if (!isTour) {
                      onSelectTab(entry.id);
                    }
                  }}
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
            aria-keyshortcuts={closeKey === undefined ? undefined : kbdGlyph(closeKey)}
            disabled={isTour}
            onClick={() => {
              if (!isTour) {
                onClose();
              }
            }}
          >
            <span aria-hidden="true">×</span>
            {closeKey !== undefined ? <Kbd shortcutKey={closeKey} /> : null}
          </button>
        </div>
        <div
          role="tabpanel"
          id="sidepanel-tabpanel-chaos"
          aria-labelledby="sidepanel-tab-chaos"
          className="sidepanel-body"
          hidden={tab !== "chaos"}
        >
          <ChaosLadder
            levels={chaosLevels}
            liveScenario={liveScenario}
            selectedLevel={chaosLevel}
            phase={chaosPhase}
            onSelectLevel={setChaosLevel}
            disabled={isTour}
          />
        </div>
        <div
          role="tabpanel"
          id="sidepanel-tabpanel-algorithm"
          aria-labelledby="sidepanel-tab-algorithm"
          className="sidepanel-body"
          hidden={tab !== "algorithm"}
        >
          <AlgorithmEditor onRun={onApply} active={tab === "algorithm"} />
        </div>
        <div
          role="tabpanel"
          id="sidepanel-tabpanel-options"
          aria-labelledby="sidepanel-tab-options"
          className="sidepanel-body"
          hidden={tab !== "options"}
        >
          <div className="sidepanel-options">
            <button
              type="button"
              className="sidepanel-options-button"
              aria-keyshortcuts={mapToggleKey === undefined ? undefined : kbdGlyph(mapToggleKey)}
              onClick={onToggleMap}
            >
              {mapShown ? "Hide metro view" : "Show metro view"}
              {mapToggleKey !== undefined ? <Kbd shortcutKey={mapToggleKey} /> : null}
            </button>
            <button
              type="button"
              className="sidepanel-options-button"
              aria-keyshortcuts={retakeTourKey === undefined ? undefined : kbdGlyph(retakeTourKey)}
              onClick={onStartTour}
            >
              Retake tour
              {retakeTourKey !== undefined ? <Kbd shortcutKey={retakeTourKey} /> : null}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
