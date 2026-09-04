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
import { type RefObject, useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import { tourCopy } from "../content/narrative";
import { hasSeenTour, markTourSeen } from "../onboarding-storage";
import {
  createTourDriver,
  type TourDriverFactory,
  type TourDriverInstance,
  type TourDriveStepConfig,
  type TourPopoverDom,
} from "./driver-factory";
import { tourSteps } from "./tour-steps.data";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/** The mobile breakpoint (GH133-PLAN.md): the identical string `src/index.css` uses
 *  for `.metro-view`/`.metro-key`'s own mobile rules, so `startTour`'s one-time read
 *  and the CSS never drift apart. */
const NARROW_QUERY = "(max-width: 719.98px)";

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
  /** Whether a modal currently owns the shell (Codex round 3 MAJOR). The auto-start
   *  defers — without consuming its one-shot session guard — while this reads true, so
   *  a first-load tour never drives over an open modal such as the legend dialog. Read
   *  lazily at the auto-start timer, so `App.tsx` can back it with a ref it writes
   *  after `modalOpen` is derived. Omitted (or absent) means "never blocked". */
  isModalOpen?: (() => boolean) | undefined;
  /**
   * The synchronous "the tour owns the keyboard" flag (GH137-PLAN.md): owned by
   * `App.tsx`, shared with `shortcuts/use-shortcuts.tsx`'s dispatcher, which bails on it
   * before looking up a mnemonic — driver.js owns the keyboard while the tour drives.
   * Set `true` here right before `instance.drive()`, cleared in `onDestroyed` and on
   * unmount. Optional: omitted entirely, this hook just never touches it (a test with
   * no shortcuts provider in the tree, or a caller that predates GH137).
   */
  tourOwnsKeyboardRef?: RefObject<boolean> | undefined;
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

/** `tourSteps` + `tourCopy`, resolved into driver.js's own step shape. On a narrow
 *  screen (GH133-PLAN.md), every step's `side` is forced to `"bottom"`: the desktop
 *  `side` values in `tour-steps.data.ts` assume room to a step's left/right/top that
 *  a phone viewport does not have, and driver.js itself flips to top near the page
 *  bottom when there is no room below. Not exported: only `startTour` (below) ever
 *  needs it, so it stays this module's own concern. */
function buildSteps(isNarrow: boolean): TourDriveStepConfig[] {
  return tourSteps.map((step) => {
    const copy = tourCopy[step.copyKey];
    return {
      element: `[data-tour="${step.target}"]`,
      popover: {
        title: copy.title,
        description: copy.description,
        side: isNarrow ? "bottom" : step.side,
      },
    };
  });
}

/** One badge in the footer hint, plain DOM (`kbd.kbd`, `aria-hidden`), matching
 *  `Kbd.tsx`'s own React output. */
function buildHintBadge(glyph: string): HTMLElement {
  const kbd = document.createElement("kbd");
  kbd.className = "kbd";
  kbd.setAttribute("aria-hidden", "true");
  kbd.textContent = glyph;
  return kbd;
}

/** Appends the tour footer's shortcut hint, "← → move · Esc exit" (GH137-PLAN.md
 *  M3), to a step's popover footer. Built as plain DOM, not a mounted `<ShortcutHint>`
 *  (`shortcuts/Kbd.tsx`): driver.js renders its own popover DOM entirely outside
 *  React, so this hand-builds the same markup/CSS classes that component would
 *  produce, rather than mounting a second React root into a node this hook does not
 *  own past the step's own lifetime. Static text — the tour already disables
 *  animation under reduced motion (`animate: !reducedMotion` in `startTour` below),
 *  so no extra reduced-motion handling is needed here. Runs on every step (driver.js
 *  calls `onPopoverRender` once per step's own popover build), so it never needs to
 *  guard against appending twice to the SAME footer node. */
function appendShortcutHint(popover: TourPopoverDom): void {
  const hint = document.createElement("p");
  hint.className = "shortcut-hint";

  const move = document.createElement("span");
  move.className = "shortcut-hint-entry";
  move.append(
    buildHintBadge("←"),
    document.createTextNode(" "),
    buildHintBadge("→"),
    document.createTextNode(" move"),
  );

  const sep = document.createElement("span");
  sep.className = "shortcut-hint-sep";
  sep.setAttribute("aria-hidden", "true");
  sep.textContent = " · ";

  const exit = document.createElement("span");
  exit.className = "shortcut-hint-entry";
  exit.append(buildHintBadge("Esc"), document.createTextNode(" exit"));

  hint.append(move, sep, exit);
  popover.footer.append(hint);
}

export function useTour({
  triggerRef,
  createDriver = createTourDriver,
  openDrawer,
  closeDrawer,
  isModalOpen,
  tourOwnsKeyboardRef,
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
  // Bumped on every navigate() call, so a superseded transition — a rapid second Next,
  // or a Previous during a pending drawer wait — can never move the driver (Codex §6
  // fix 3). Finer-grained than `sessionRef`, which only changes per whole tour.
  const navGenerationRef = useRef(0);
  // Whether the tour currently holds the drawer open. Navigation closes it based on the
  // DESTINATION step, not just on leaving the drawer step, so a reversal made mid-entry
  // (which already opened the drawer) still closes it (Codex §6 loop-2).
  const drawerOpenRef = useRef(false);

  const startTour = useCallback((): void => {
    focusGenerationRef.current += 1;
    const generation = focusGenerationRef.current;
    sessionRef.current += 1;
    const session = sessionRef.current;
    const isCurrent = (): boolean => sessionRef.current === session;
    // A fresh start owns the seen-flag: clear any suppression a cancelled Strict Mode
    // setup may have armed (Codex §6 fix 1), so this run's real dismissal marks seen.
    suppressSeenRef.current = false;
    drawerOpenRef.current = false;
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
      navGenerationRef.current += 1;
      const navGeneration = navGenerationRef.current;
      const from = inst.getActiveIndex() ?? 0;
      const to = from + direction;
      const move = (): void => {
        if (!isCurrent() || navGenerationRef.current !== navGeneration) {
          return;
        }
        if (direction > 0) {
          inst.moveNext();
        } else {
          inst.movePrevious();
        }
      };
      const destinationWantsDrawer = tourSteps[to]?.opensDrawer === true;
      if (destinationWantsDrawer) {
        openDrawer?.();
        drawerOpenRef.current = true;
        void waitFor(() => document.querySelector(CHAOS_SELECTOR) !== null, isCurrent).then(move);
      } else if (drawerOpenRef.current) {
        // The drawer is open — from this step, or from a superseded entry a reversal
        // interrupted — but the destination does not want it. Close it and wait for its
        // removal before moving, so a reversal mid-entry never strands the panel open.
        closeDrawer?.();
        drawerOpenRef.current = false;
        void waitFor(() => document.querySelector(CHAOS_SELECTOR) === null, isCurrent).then(move);
      } else {
        move();
      }
    };

    const reducedMotion = window.matchMedia(REDUCED_MOTION_QUERY).matches;
    // A one-time read (GH133-PLAN.md), not a listener: driver.js recomputes its own
    // popover geometry on resize and falls back to a fitting side, so a rotated
    // popover stays usable even though this value does not re-place mid-tour.
    const isNarrow = window.matchMedia(NARROW_QUERY).matches;

    // Code review finding (MAJOR): `createDriver()`/`instance.drive()` can throw (a
    // hostile fake in tests, or a real driver.js failure). Without this try/catch, a
    // throw here would leave `tourOwnsKeyboardRef.current` stuck `true` forever — it is
    // set just below, before `drive()` — so the shortcuts dispatcher's bail check #1
    // (`use-shortcuts.tsx`) would suppress every mnemonic for the rest of the session,
    // with no tour actually running to explain why. On a throw, this resets exactly the
    // state `onDestroyed`/unmount would leave (the ref cleared, `active` false, the
    // drawer closed if this attempt opened it, `sessionRef` bumped so no stray pending
    // wait can act, `driverRef` nulled), then rethrows so the caller still learns the
    // start failed.
    try {
      const instance = createDriver({
        steps: buildSteps(isNarrow),
        disableActiveInteraction: true,
        animate: !reducedMotion,
        onPopoverRender: appendShortcutHint,
        onNextClick: () => navigate(1),
        onPrevClick: () => navigate(-1),
        onDestroyed: () => {
          // Clear the synchronous internal state FIRST (Codex review): the session
          // guard, the drawer flag, `active`, and — critically — keyboard ownership, so
          // a `closeDrawer` that throws below can never leave the shortcuts dispatcher
          // permanently bailed.
          sessionRef.current += 1; // abort any pending drawer wait
          drawerOpenRef.current = false;
          setActive(false);
          if (tourOwnsKeyboardRef !== undefined) {
            tourOwnsKeyboardRef.current = false; // the shortcuts dispatcher is live again
          }
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
          // External callback LAST, and guarded: the invariants above already hold, so a
          // throw here (a tour ended on the drawer step must still close the panel) can
          // no longer strand ownership.
          try {
            closeDrawer?.();
          } catch {
            // internal state is already reset; a drawer-close failure must not undo it
          }
        },
      });
      driverRef.current = instance;
      if (tourOwnsKeyboardRef !== undefined) {
        tourOwnsKeyboardRef.current = true; // driver.js owns the keyboard until onDestroyed
      }
      instance.drive();
    } catch (err) {
      // A partially-started driver may already have added its global listeners, so make
      // a best-effort `destroy()` (Codex review): it re-enters the reordered
      // `onDestroyed` above, which clears state and closes the drawer. The start never
      // ran, so suppress its seen-write. Guarded — a half-built instance may not destroy
      // cleanly, and nothing here may mask the original error.
      const failed = driverRef.current;
      driverRef.current = null;
      const hadDrawer = drawerOpenRef.current;
      suppressSeenRef.current = true;
      try {
        failed?.destroy();
      } catch {
        // a half-initialized driver may not tear down cleanly; the throw below matters
      }
      suppressSeenRef.current = false;
      // Close the drawer this attempt opened EXACTLY ONCE (Codex review): a successful
      // destroy() re-entered `onDestroyed`, which already cleared `drawerOpenRef` and
      // closed the panel — so `drawerOpenRef` still reading true means `onDestroyed` did
      // NOT run (destroy() threw or fired no callback), and the panel is still open.
      if (hadDrawer && drawerOpenRef.current) {
        try {
          closeDrawer?.();
        } catch {
          // internal state is reset below regardless; the original error still rethrows
        }
      }
      // Re-assert the synchronous invariants UNCONDITIONALLY, whether or not
      // destroy()/onDestroyed ran, so keyboard ownership can never be left stuck.
      sessionRef.current += 1;
      drawerOpenRef.current = false;
      setActive(false);
      if (tourOwnsKeyboardRef !== undefined) {
        tourOwnsKeyboardRef.current = false; // never leave the dispatcher permanently bailed
      }
      throw err;
    }
  }, [createDriver, triggerRef, openDrawer, closeDrawer, tourOwnsKeyboardRef]);

  // The auto-start action, as an Effect Event. It always reads the LATEST COMMITTED
  // `startTour` (whose identity churns as App.tsx rebuilds `openDrawer`/`closeDrawer`
  // every render), so the auto-start effect below need not depend on it, and there is no
  // render-phase ref a discarded concurrent render could leave stale (CodeRabbit review).
  // `useEffectEvent` is the right tool here precisely because this callback is only ever
  // called locally, from the effect's own timer — never passed down (unlike App.tsx's
  // `openDrawer`/`closeDrawer` refs, which are handed to `useTour` and so cannot be
  // Effect Events).
  // Returns whether the auto-start is settled — either it started, or a prior mount
  // this session already did. Returns false ONLY when a modal is open (Codex round 3
  // MAJOR): the tour must not drive over an open legend/dialog, so it defers WITHOUT
  // consuming the one-shot session guard, and the effect below re-arms until the modal
  // closes. On first load no modal is open, so this starts immediately as before.
  const autoStart = useEffectEvent((): boolean => {
    if (autoStartedThisSession) {
      return true; // a prior mount (this session) already auto-started; retake is unaffected
    }
    if (isModalOpen?.() === true) {
      return false; // a modal owns the shell; wait — do not consume the session guard
    }
    autoStartedThisSession = true;
    startTour();
    return true;
  });

  // Auto-start on first load, StrictMode-safe (GH132-PLAN.md M3, see the module doc):
  // `hasSeenAtMount` is fixed for this hook instance's whole life, so this effect's
  // dependency array never actually changes across re-renders — it runs (and its
  // cleanup runs) only on a true mount/unmount, exactly like the plain `[]` unmount
  // effect it replaces.
  useEffect(() => {
    let pending: ReturnType<typeof setTimeout> | null = null;
    // Re-arm while the auto-start is blocked by an open modal (Codex round 3): each
    // tick either settles (started, or already started this session) or re-defers, so
    // a modal open at load only delays the tour until it closes — it never suppresses
    // it. `pending` stays the single cancellable handle the cleanup below clears, so
    // Strict Mode's teardown still cancels a not-yet-fired start exactly as before.
    const tick = (): void => {
      pending = null;
      if (!autoStart()) {
        pending = setTimeout(tick, 100);
      }
    };
    if (!hasSeenAtMount) {
      pending = setTimeout(tick, 0);
    }
    return () => {
      if (pending !== null) {
        clearTimeout(pending); // cancel FIRST: a Strict Mode teardown must never fire this
      }
      if (tourOwnsKeyboardRef !== undefined) {
        tourOwnsKeyboardRef.current = false; // defensive: `onDestroyed` below already clears it
      }
      focusGenerationRef.current += 1;
      sessionRef.current += 1;
      // Only arm suppression when a live driver exists to destroy. A Strict Mode first
      // cleanup with no driver (its deferred start was cancelled above) must NOT leave
      // suppression set, or the surviving tour's real dismissal would skip markTourSeen
      // and the tour would re-auto-start on every reload (Codex §6 fix 1).
      if (driverRef.current !== null) {
        suppressSeenRef.current = true;
        driverRef.current.destroy();
      }
    };
  }, [hasSeenAtMount, tourOwnsKeyboardRef]);

  return { startTour, active };
}
