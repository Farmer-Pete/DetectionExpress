/**
 * The app header, extracted from `App.tsx` (GH109-PLAN.md, GH118-PLAN.md): the
 * title, the slice tag, the hamburger button, and `<HireMe>`.
 *
 * GH132-PLAN.md M2 (8-step tour redesign): the run-status pill (`StatusPill`,
 * the "RUNNING" badge) is gone. It duplicated what the live map and log already
 * show, and the tour never had a step for it.
 *
 * GH132-PLAN.md M1 (design revision, "SUPERSEDES the popup menu"): the hamburger
 * is now a plain icon button, not a popup-menu trigger. Clicking it opens the
 * side panel directly (`onOpenMenu`, wired to `sidePanel.openPanel` in
 * `App.tsx`) — no `role="menu"` list, no `ui/menu/` component. The three
 * actions that used to live in the popup (Chaos ladder, Edit Engine, the map
 * toggle) and the standalone "How this works" reopen button are gone from here
 * too: the side panel's own "Options" tab (`SidePanel.tsx`) now carries the map
 * toggle and the intro-reopen action. `hamburgerTriggerRef` is exposed the same
 * way the old `reopenRef` was, so `App` can hand it to the side panel as its
 * focus-restore fallback — the one stable trigger left once the standalone
 * buttons are gone.
 *
 * The hamburger sits at the far right of the header, after `<HireMe>`: both
 * live inside `.topbar-actions`, in DOM order Hire Me then hamburger, so the
 * hamburger is the last, rightmost child of the row `.topbar-actions` already
 * pins to the header's right edge (`margin-left: auto`, `src/index.css`).
 */
import { Menu as MenuIcon } from "lucide-react";
import type { RefObject } from "react";
import { hireMe } from "./content/narrative";
import { HireMe } from "./HireMe";

interface TopbarProps {
  /** Opens the side panel (to whatever tab was last active, chaos by default). */
  onOpenMenu: () => void;
  /** The hamburger button's ref, owned by `App.tsx` so the same ref also
   *  serves as the side panel's focus-restore fallback. */
  hamburgerTriggerRef: RefObject<HTMLButtonElement | null>;
}

export function Topbar({ onOpenMenu, hamburgerTriggerRef }: TopbarProps) {
  return (
    <header className="topbar">
      <h1>Detection Express</h1>
      <span className="slice-tag">The Engine brings the detections. You bring the chaos.</span>
      <div className="topbar-actions">
        <HireMe copy={hireMe} />
        <button
          type="button"
          ref={hamburgerTriggerRef}
          className="topbar-menu-button"
          aria-label="Open menu"
          onClick={onOpenMenu}
        >
          <MenuIcon aria-hidden="true" size={18} />
        </button>
      </div>
    </header>
  );
}
