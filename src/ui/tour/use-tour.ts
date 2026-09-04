/**
 * The guided tour's controller (GH132-PLAN.md M2, docs/adr/0012-guided-tour.md). Owns
 * the one driver.js instance behind an injected factory (`createTourDriver` by default,
 * `driver-factory.ts`), so tests supply a fake and never load the real library.
 *
 * `startTour` is user-triggered in M2 (the side panel's Options tab, "Retake tour") — it
 * always starts, ignoring any seen flag. M3 adds the auto-start-on-mount effect (a lazy
 * `hasSeenTour()` read plus a cancellable deferred `drive()`, StrictMode-safe); this hook
 * already carries the two pieces that effect will need on top:
 *
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
import { markTourSeen } from "../onboarding-storage";
import {
  createTourDriver,
  type TourDriverFactory,
  type TourDriverInstance,
  type TourDriveStepConfig,
} from "./driver-factory";
import { tourSteps } from "./tour-steps.data";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

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

  useEffect(() => {
    return () => {
      focusGenerationRef.current += 1;
      sessionRef.current += 1;
      suppressSeenRef.current = true;
      driverRef.current?.destroy();
    };
  }, []);

  return { startTour, active };
}
