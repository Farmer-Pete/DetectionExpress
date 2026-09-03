/**
 * The intro overlay's controller, extracted from `App.tsx` (GH109-PLAN.md). The seen
 * flag is read once, in a lazy initializer, so the overlay decision is made before
 * first paint. Observe (also Escape and a backdrop click) closes the overlay, marks
 * it seen, and returns focus to the reopen control once the overlay has unmounted.
 *
 * "Cause chaos" and "Edit the Engine" no longer scroll the shell (GH118-PLAN.md):
 * each records which side-panel tab it wants, through the injected `onRequestPanel`
 * callback, then closes the intro the same way Observe does, but skips the
 * focus-to-reopen step. The intro button that fired is about to unmount, and once
 * `introOpen` goes false, App opens the side panel in its own effect; the panel
 * moves focus into itself on mount, so this hook has nothing left to focus.
 * `onRequestPanel` keeps this hook agnostic of the side panel: App owns what a
 * "chaos" or "algorithm" request means and how to act on it.
 *
 * GH132-PLAN.md M1 (design revision): the Topbar no longer carries a standalone
 * reopen button (the reopen action moved into the side panel's Options tab, which
 * is unmounted by the time this hook's post-close effect below can run — see
 * `App.tsx`'s "The reopen-intro transition"), so `reopenRef` alone would have
 * nothing left to attach to and the post-close focus-restore would silently
 * no-op. `reopenFocusRef` is an optional fallback the caller supplies (App hands
 * it the hamburger trigger ref, the one stable control left); the effect prefers
 * a real `reopenRef` attachment when one exists, so a future direct attachment
 * still wins.
 */
import type { ReactNode, RefObject } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { introCopy, REPO_URL } from "../content/narrative";
import { hasSeenIntro, markIntroSeen } from "../onboarding-storage";
import type { SidePanelTab } from "../sidepanel/use-side-panel";
import { IntroOverlay } from "./IntroOverlay";

export interface UseIntroOverlayArgs {
  /** Called when "Cause chaos" or "Edit the Engine" fires, with the panel tab it
   *  requests, before the intro closes. Optional so a bare `useIntroOverlay()` call
   *  still works. */
  onRequestPanel?: ((tab: SidePanelTab) => void) | undefined;
  /** Focus-restore fallback for the post-close effect, used when nothing attaches
   *  `reopenRef` directly (see the module doc). Typically the Topbar hamburger
   *  button's ref. */
  reopenFocusRef?: RefObject<HTMLElement | null> | undefined;
}

export interface IntroOverlayController {
  /** True while the intro overlay should render. */
  introOpen: boolean;
  /** Attach to the topbar reopen button; the post-close effect returns focus here. */
  reopenRef: RefObject<HTMLButtonElement | null>;
  /** Reopen the overlay from the topbar. Does not clear the seen flag. */
  onReopen: () => void;
  /** The overlay element, ready to drop into ModalHost's `overlays` slot, or null. */
  introOverlay: ReactNode;
}

export function useIntroOverlay({
  onRequestPanel,
  reopenFocusRef,
}: UseIntroOverlayArgs = {}): IntroOverlayController {
  const [introOpen, setIntroOpen] = useState(() => !hasSeenIntro());
  const reopenRef = useRef<HTMLButtonElement>(null);
  // True for a dismiss that should return focus to the reopen control once the
  // overlay unmounts (Observe, Escape, a backdrop click). False for Cause
  // chaos/Edit the Engine: the side panel that opens next moves focus itself.
  const pendingReopenFocus = useRef(false);

  // Dismiss the overlay: mark it seen and close it. Every dismissing action routes
  // through this, so a storage failure never blocks the close (the wrapper swallows
  // it).
  //
  // Stable identity (F020): `useCallback`'d, with `onObserve`/`onCauseChaos`/
  // `onEditEngine` below wrapping it the same way, so the handlers IntroOverlay
  // receives keep one identity across App re-renders. IntroOverlay's own
  // outside-pointer-dismiss effect (`src/ui/focus.ts`) keys its cleanup/re-install
  // on `onObserve`'s identity; a fresh function every render would tear that
  // listener down and reinstall it on every App render, not just on open/close.
  const dismissIntro = useCallback((focusReopen: boolean): void => {
    markIntroSeen();
    pendingReopenFocus.current = focusReopen;
    setIntroOpen(false);
  }, []);

  const onObserve = useCallback(() => dismissIntro(true), [dismissIntro]);
  const onCauseChaos = useCallback(() => {
    onRequestPanel?.("chaos");
    dismissIntro(false);
  }, [dismissIntro, onRequestPanel]);
  const onEditEngine = useCallback(() => {
    onRequestPanel?.("algorithm");
    dismissIntro(false);
  }, [dismissIntro, onRequestPanel]);

  // After the overlay unmounts, return focus to the reopen control, but only for a
  // dismiss that asked for it. Reading the ref here, not at click time, keeps this
  // off the (about to unmount) overlay.
  useEffect(() => {
    if (introOpen) {
      return;
    }
    if (!pendingReopenFocus.current) {
      return;
    }
    pendingReopenFocus.current = false;
    const target = reopenRef.current ?? reopenFocusRef?.current;
    target?.focus({ preventScroll: true });
  }, [introOpen, reopenFocusRef]);

  const onReopen = useCallback(() => setIntroOpen(true), []);

  const introOverlay = introOpen ? (
    <IntroOverlay
      copy={introCopy}
      repoUrl={REPO_URL}
      onObserve={onObserve}
      onCauseChaos={onCauseChaos}
      onEditEngine={onEditEngine}
    />
  ) : null;

  return { introOpen, reopenRef, onReopen, introOverlay };
}
