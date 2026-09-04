/**
 * The guided tour's controller (GH132-PLAN.md M2/M3, docs/adr/0012-guided-tour.md). Owns
 * the one driver.js instance behind an injected factory (`createTourDriver` by default,
 * `driver-factory.ts`), so tests supply a fake and never load the real library.
 *
 * `startTour` is user-triggered from the side panel's Options tab ("Retake tour") — it
 * always starts, ignoring both the seen flag and the auto-start session guard below.
 *
 * - **Auto-start on first load, StrictMode-safe** (GH132-PLAN.md M3, "Tour wiring"
 *   finding 1): `hasSeenAtMount` is a pure `hasSeenTour()` read taken once, in a lazy
 *   `useState` initializer, so it can never observe a write this same session makes.
 *   The mount effect below only SCHEDULES the drive, via a deferred macrotask
 *   (`setTimeout(fn, 0)`) it can still cancel: React Strict Mode's dev-only
 *   mount -> cleanup -> mount runs the cleanup (which cancels the pending timeout)
 *   before that timeout ever fires, so the FIRST setup's deferred task never drives,
 *   and only the SURVIVING setup's timeout actually calls `startTour`. The module-level
 *   `autoStartedThisSession` guard is set inside that deferred callback, right before
 *   `startTour()` — never at scheduling time — so a cancelled first task can never
 *   suppress the surviving one. It lives OUTSIDE the component (not a ref), so a
 *   from-scratch remount within the same page load (e.g. storage blocked, which always
 *   reads `hasSeenTour()` as false) still auto-starts at most once per loaded session,
 *   which a ref reset on every fresh mount could not guarantee. On cleanup: cancel the
 *   pending timeout FIRST (so a not-yet-fired auto-start can never run after teardown
 *   starts), then set the seen-suppression flag, then `destroy()` the instance — the
 *   same order and the same cleanup this hook already needed for a real unmount.
 * - **Seen-flag via `onDestroyed`** (Tour wiring, finding 6): driver.js's `onDestroyed`
 *   fires on Done, close, Escape, backdrop dismissal, AND a programmatic `destroy()` call
 *   — the path this hook's own unmount cleanup takes. `suppressSeenRef` is set right
 *   before that cleanup `destroy()`, so a React unmount (including a Strict Mode
 *   teardown) is never mistaken for a real dismissal and never marks the tour seen. It is
 *   one-shot: cleared the instant `onDestroyed` reads it, so a later real dismissal on a
 *   fresh instance still records seen normally.
 * - **Focus restore to a stable trigger** (findings 5, 7): driver.js runs its own
 *   final saved-element focus AFTER `onDestroyed` returns, so a synchronous `focus()`
 *   call inside the handler would be immediately overwritten. This defers the restore to
 *   a microtask, gated by a generation token bumped on every `startTour()` call and on
 *   unmount, so a stale restore from a superseded or torn-down tour never fires.
 */
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { tourCopy } from "../content/narrative";
import { hasSeenTour, markTourSeen } from "../onboarding-storage";
import {
  createTourDriver,
  type TourDriverFactory,
  type TourDriverInstance,
  type TourDriveStepConfig,
} from "./driver-factory";
import { tourSteps } from "./tour-steps.data";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

// In-memory, module-scoped (deliberately NOT component state): "at most one auto-start
// per loaded session" (GH132-PLAN.md M3, "Session guard" finding 9) has to survive past
// any single hook instance's lifetime — a ref would reset on a fresh mount, defeating
// the guard exactly when storage is blocked and `hasSeenTour()` always reads false.
// Read and set only inside the deferred auto-start callback below; `startTour()` (a
// manual retake) never consults it.
let autoStartedThisSession = false;

/** Test-only: clears the module-level auto-start guard. Without this, one test's
 *  auto-start would leave every later test in the same file unable to auto-start,
 *  since the guard otherwise lives for the whole module's lifetime by design. */
export function resetTourAutoStartForTests(): void {
  autoStartedThisSession = false;
}

export interface UseTourArgs {
  /** Focus-restore target once the tour ends: the Topbar hamburger button's ref. */
  triggerRef: RefObject<HTMLElement | null>;
  /** Injected driver.js factory. Tests pass a fake; `App.tsx` leaves the real default. */
  createDriver?: TourDriverFactory | undefined;
  /** Opens the side panel in tour mode (to the chaos tab) for the drawer step
   *  (GH132-PLAN.md M2, "Step 2 drawer-open"). `App.tsx` wires this to `openForTour`. */
  openDrawer?: (() => void) | undefined;
  /** Closes the tour-mode side panel. Wired to `useSidePanel`'s `closeForTour`. */
  closeDrawer?: (() => void) | undefined;
}

export interface TourController {
  /** Builds and drives the tour. Always starts — a retake ignores any seen flag. */
  startTour: () => void;
  /** True while the tour is running. `App.tsx` ORs it into `overlayOpen` so the log's
   *  Space-to-freeze shortcut stays suppressed during the tour (Codex fix 1), without
   *  making the shell inert. */
  active: boolean;
}

/** The drawer step's spotlight target. Its presence in the DOM is how "the panel has
 *  committed open" is detected, per the own-the-wait rule (Codex fix 4). */
const CHAOS_SELECTOR = '[data-tour="chaos"]';

/** Resolve once `predicate` holds, or the session is superseded, or a 1.5s cap elapses
 *  (best-effort, so a missing element never hangs the tour). Polls on a timer, not
 *  `requestAnimationFrame`, so it still ticks when the tab is not the visible one (rAF is
 *  paused in hidden tabs, which would strand a transition). */
function waitFor(predicate: () => boolean, isCurrent: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = (): void => {
      if (!isCurrent() || predicate() || Date.now() - start > 1500) {
        resolve();
        return;
      }
      setTimeout(tick, 16);
    };
    setTimeout(tick, 16);
  });
}

/** `tourSteps` + `tourCopy`, resolved into driver.js's own step shape. */
function buildSteps(): TourDriveStepConfig[] {
  return tourSteps.map((step) => {
    const copy = tourCopy[step.copyKey];
    return {
      element: `[data-tour="${step.target}"]`,
      popover: {
        title: copy.title,
        description: copy.description,
        side: step.side,
      },
    };
  });
}

export function useTour({
  triggerRef,
  createDriver = createTourDriver,
  openDrawer,
  closeDrawer,
}: UseTourArgs): TourController {
  const [active, setActive] = useState(false);
  // A pure, one-time read (GH132-PLAN.md M3): taken in a lazy initializer, so it can
  // never see a `markTourSeen()` write this same render/session makes, and its value
  // never changes across re-renders regardless of what the tour does afterward.
  const [hasSeenAtMount] = useState(() => hasSeenTour());
  const driverRef = useRef<TourDriverInstance | null>(null);
  // One-shot: set right before an unmount's `destroy()`, so the `onDestroyed` it
  // triggers is never mistaken for a real dismissal. Cleared the instant `onDestroyed`
  // reads it.
  const suppressSeenRef = useRef(false);
  // Bumped on every startTour() call and on unmount, so a stale focus-restore
  // microtask from a superseded or torn-down tour can never fire.
  const focusGenerationRef = useRef(0);
  // Bumped on every startTour() call, on onDestroyed, and on unmount, so a pending
  // drawer wait from a superseded or ended tour can never move a dead instance
  // (Codex fix 4: an aborted transition must not act).
  const sessionRef = useRef(0);

  const startTour = useCallback((): void => {
    focusGenerationRef.current += 1;
    const generation = focusGenerationRef.current;
    sessionRef.current += 1;
    const session = sessionRef.current;
    const isCurrent = (): boolean => sessionRef.current === session;
    setActive(true);

    // Own the wait (Codex fix 4/5): driver.js has no cancel for its internal element
    // wait, so we override navigation. Entering the drawer step opens the panel, waits
    // for its React commit (the chaos anchor appears), THEN advances. Leaving it closes
    // the panel, waits for the commit, THEN moves — so the panel backdrop never covers
    // the next target for a frame.
    const navigate = (direction: 1 | -1): void => {
      const inst = driverRef.current;
      if (inst === null) {
        return;
      }
      const from = inst.getActiveIndex() ?? 0;
      const to = from + direction;
      const move = (): void => {
        if (!isCurrent()) {
          return;
        }
        if (direction > 0) {
          inst.moveNext();
        } else {
          inst.movePrevious();
        }
      };
      const leavingDrawer = tourSteps[from]?.opensDrawer === true;
      const enteringDrawer = tourSteps[to]?.opensDrawer === true;
      if (enteringDrawer) {
        openDrawer?.();
        void waitFor(() => document.querySelector(CHAOS_SELECTOR) !== null, isCurrent).then(move);
      } else if (leavingDrawer) {
        closeDrawer?.();
        void waitFor(() => document.querySelector(CHAOS_SELECTOR) === null, isCurrent).then(move);
      } else {
        move();
      }
    };

    const reducedMotion = window.matchMedia(REDUCED_MOTION_QUERY).matches;

    const instance = createDriver({
      steps: buildSteps(),
      disableActiveInteraction: true,
      animate: !reducedMotion,
      onNextClick: () => navigate(1),
      onPrevClick: () => navigate(-1),
      onDestroyed: () => {
        sessionRef.current += 1; // abort any pending drawer wait
        closeDrawer?.(); // a tour ended on the drawer step must close the panel
        setActive(false);
        if (!suppressSeenRef.current) {
          markTourSeen();
        }
        suppressSeenRef.current = false;
        // Deferred to a microtask: driver.js focuses its own saved element right
        // after onDestroyed returns, which would clobber a synchronous call here.
        Promise.resolve().then(() => {
          if (focusGenerationRef.current === generation) {
            triggerRef.current?.focus();
          }
        });
      },
    });
    driverRef.current = instance;
    instance.drive();
  }, [createDriver, triggerRef, openDrawer, closeDrawer]);

  // `startTour`'s identity churns whenever `openDrawer`/`closeDrawer` do (App.tsx
  // rebuilds those two callbacks every render), so the auto-start effect below reads
  // it through this ref instead of listing it as a dependency — the same bridge
  // pattern App.tsx itself uses for `closeSidePanelRef`/`openDrawerRef`. Written every
  // render, never inside an effect, so it is never one render stale.
  const startTourRef = useRef(startTour);
  startTourRef.current = startTour;

  // Auto-start on first load, StrictMode-safe (GH132-PLAN.md M3, see the module doc):
  // `hasSeenAtMount` is fixed for this hook instance's whole life, so this effect's
  // dependency array never actually changes across re-renders — it runs (and its
  // cleanup runs) only on a true mount/unmount, exactly like the plain `[]` unmount
  // effect it replaces.
  useEffect(() => {
    let pending: ReturnType<typeof setTimeout> | null = null;
    if (!hasSeenAtMount) {
      pending = setTimeout(() => {
        pending = null;
        if (autoStartedThisSession) {
          return; // a prior mount (this session) already auto-started; retake is unaffected
        }
        autoStartedThisSession = true;
        startTourRef.current();
      }, 0);
    }
    return () => {
      if (pending !== null) {
        clearTimeout(pending); // cancel FIRST: a Strict Mode teardown must never fire this
      }
      focusGenerationRef.current += 1;
      sessionRef.current += 1;
      suppressSeenRef.current = true;
      driverRef.current?.destroy();
    };
  }, [hasSeenAtMount]);

  return { startTour, active };
}
