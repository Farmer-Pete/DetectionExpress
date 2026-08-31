/**
 * The intro overlay's controller, extracted from `App.tsx` (GH109-PLAN.md). The seen
 * flag is read once, in a lazy initializer, so the overlay decision is made before
 * first paint. A dismissing action records its intent in a ref, then an effect acts
 * on it after the overlay has unmounted, so the scroll always lands on the mounted
 * shell. The intent lives in a ref, not state, so the effect runs once per dismiss
 * and never re-triggers itself.
 */

import type { ReactNode, RefObject } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { introCopy, REPO_URL } from "../content/narrative";
import { hasSeenIntro, markIntroSeen } from "../onboarding-storage";
import { IntroOverlay } from "./IntroOverlay";

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

export function useIntroOverlay(): IntroOverlayController {
  const [introOpen, setIntroOpen] = useState(() => !hasSeenIntro());
  const reopenRef = useRef<HTMLButtonElement>(null);
  const pendingDismiss = useRef<{ scrollTarget: string | null } | null>(null);

  // Dismiss the overlay. Every dismissing action marks the intro seen and records its
  // scroll target for the post-close effect. A storage failure never blocks the close,
  // since the wrapper swallows it.
  //
  // Stable identity (F020): `useCallback`'d, with `onObserve`/`onCauseChaos`/
  // `onEditEngine` below wrapping it the same way, so the handlers IntroOverlay
  // receives keep one identity across App re-renders. IntroOverlay's own
  // outside-pointer-dismiss effect (`src/ui/focus.ts`) keys its cleanup/re-install
  // on `onObserve`'s identity; a fresh function every render would tear that
  // listener down and reinstall it on every App render, not just on open/close.
  const dismissIntro = useCallback((target: string | null): void => {
    markIntroSeen();
    pendingDismiss.current = { scrollTarget: target };
    setIntroOpen(false);
  }, []);

  const onObserve = useCallback(() => dismissIntro(null), [dismissIntro]);
  const onCauseChaos = useCallback(() => dismissIntro("chaos-ladder"), [dismissIntro]);
  const onEditEngine = useCallback(() => dismissIntro("algorithm-editor"), [dismissIntro]);

  // After the overlay unmounts, act on the recorded dismiss intent exactly once.
  // A scroll action scrolls to its target, then moves focus there without a second
  // scroll. Observe and Escape carry no target, so focus returns to the reopen
  // control. Reading the anchor here, not at click time, keeps the scroll off the
  // overlay.
  useEffect(() => {
    if (introOpen) {
      return;
    }
    const pending = pendingDismiss.current;
    if (pending === null) {
      return;
    }
    pendingDismiss.current = null;
    if (pending.scrollTarget !== null) {
      const target = document.getElementById(pending.scrollTarget);
      target?.scrollIntoView({ behavior: "smooth", block: "start" });
      target?.focus({ preventScroll: true });
    } else {
      reopenRef.current?.focus({ preventScroll: true });
    }
  }, [introOpen]);

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
