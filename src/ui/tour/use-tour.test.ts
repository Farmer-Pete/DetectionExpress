/**
 * `useTour`'s controller tests (GH132-PLAN.md Test seams #4, M2 slice: `startTour` is
 * user-triggered here — the auto-start-on-mount effect is M3). A fake `TourDriverFactory`
 * stands in for driver.js: it records the config it was built with and exposes the
 * captured `onDestroyed` callback so a test can fire it directly, the same way a real
 * Done/close/Escape/backdrop dismissal — or a programmatic `destroy()` — would.
 */
import { act, renderHook } from "@testing-library/react";
import { createRef, StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tourCopy } from "../content/narrative";
import { hasSeenTour, markTourSeen } from "../onboarding-storage";
import type { TourDriverConfig, TourDriverFactory, TourDriverInstance } from "./driver-factory";
import { tourSteps } from "./tour-steps.data";
import { resetTourAutoStartForTests, useTour } from "./use-tour";

/** A fake driver.js instance: records `drive`/`destroy` calls and exposes the config it
 *  was built with, so a test can invoke `onDestroyed` itself. */
function fakeDriverInstance(config: TourDriverConfig): TourDriverInstance & {
  driveCalls: number;
  destroyCalls: number;
} {
  let driveCalls = 0;
  let destroyCalls = 0;
  return {
    get driveCalls() {
      return driveCalls;
    },
    get destroyCalls() {
      return destroyCalls;
    },
    drive() {
      driveCalls += 1;
    },
    destroy() {
      destroyCalls += 1;
      // Real driver.js fires onDestroyed on a programmatic destroy() too — this is
      // exactly the path an unmount's cleanup-suppressed `destroy()` call exercises.
      config.onDestroyed?.();
    },
    moveNext() {},
    movePrevious() {},
    moveTo() {},
    getActiveIndex() {
      return 0;
    },
  };
}

/** A spy factory: records every config it was called with and returns a fresh fake
 *  instance each time, so a test can reach into the last-built config directly. */
function spyFactory() {
  const configs: TourDriverConfig[] = [];
  const instances: ReturnType<typeof fakeDriverInstance>[] = [];
  const createDriver = vi.fn((config: TourDriverConfig) => {
    configs.push(config);
    const instance = fakeDriverInstance(config);
    instances.push(instance);
    return instance;
  });
  return { createDriver, configs, instances };
}

function stubReducedMotion(matches: boolean): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
}

/** Stubs `window.matchMedia` so the narrow-screen query (`(max-width: 719.98px)`,
 *  `use-tour.ts`'s `NARROW_QUERY`) reads `narrow`, independent of any other query
 *  (e.g. reduced-motion) `startTour` also reads. */
function stubNarrow(narrow: boolean): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(max-width: 719.98px)" ? narrow : false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
}

/** Flushes the auto-start effect's deferred macrotask (`setTimeout(fn, 0)`). */
async function flushDeferredAutoStart(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  stubReducedMotion(false);
  localStorage.clear();
  resetTourAutoStartForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useTour", () => {
  it("startTour builds one driver.js step per tourStep, resolved to its data-tour selector and copy", () => {
    const { createDriver, configs } = spyFactory();
    const triggerRef = createRef<HTMLButtonElement>();
    const { result } = renderHook(() => useTour({ triggerRef, createDriver }));

    act(() => result.current.startTour());

    expect(createDriver).toHaveBeenCalledTimes(1);
    const config = configs[0];
    expect(config).toBeDefined();
    expect(config?.steps).toHaveLength(tourSteps.length);
    tourSteps.forEach((step, index) => {
      const built = config?.steps[index];
      expect(built?.element).toBe(`[data-tour="${step.target}"]`);
      expect(built?.popover.title).toBe(tourCopy[step.copyKey].title);
      expect(built?.popover.description).toBe(tourCopy[step.copyKey].description);
      expect(built?.popover.side).toBe(step.side);
    });
  });

  it("uses each step's desktop side (tour-steps.data.ts) on a wide screen", () => {
    stubNarrow(false);
    const { createDriver, configs } = spyFactory();
    const triggerRef = createRef<HTMLButtonElement>();
    const { result } = renderHook(() => useTour({ triggerRef, createDriver }));

    act(() => result.current.startTour());

    tourSteps.forEach((step, index) => {
      expect(configs[0]?.steps[index]?.popover.side).toBe(step.side);
    });
  });

  it("forces every step's side to bottom on a narrow screen (GH133-PLAN.md)", () => {
    stubNarrow(true);
    const { createDriver, configs } = spyFactory();
    const triggerRef = createRef<HTMLButtonElement>();
    const { result } = renderHook(() => useTour({ triggerRef, createDriver }));

    act(() => result.current.startTour());

    for (const built of configs[0]?.steps ?? []) {
      expect(built.popover.side).toBe("bottom");
    }
  });

  it("calls drive() on the built instance", () => {
    const { createDriver, instances } = spyFactory();
    const triggerRef = createRef<HTMLButtonElement>();
    const { result } = renderHook(() => useTour({ triggerRef, createDriver }));

    act(() => result.current.startTour());

    expect(instances[0]?.driveCalls).toBe(1);
  });

  it("sets disableActiveInteraction: true (the tour is narrated, not interactive)", () => {
    const { createDriver, configs } = spyFactory();
    const triggerRef = createRef<HTMLButtonElement>();
    const { result } = renderHook(() => useTour({ triggerRef, createDriver }));

    act(() => result.current.startTour());

    expect(configs[0]?.disableActiveInteraction).toBe(true);
  });

  it("sets animate: true when the player has no reduced-motion preference", () => {
    stubReducedMotion(false);
    const { createDriver, configs } = spyFactory();
    const triggerRef = createRef<HTMLButtonElement>();
    const { result } = renderHook(() => useTour({ triggerRef, createDriver }));

    act(() => result.current.startTour());

    expect(configs[0]?.animate).toBe(true);
  });

  it("sets animate: false when the player prefers reduced motion", () => {
    stubReducedMotion(true);
    const { createDriver, configs } = spyFactory();
    const triggerRef = createRef<HTMLButtonElement>();
    const { result } = renderHook(() => useTour({ triggerRef, createDriver }));

    act(() => result.current.startTour());

    expect(configs[0]?.animate).toBe(false);
  });

  it("marks the tour seen from onDestroyed (Done, close, Escape, or backdrop)", () => {
    const { createDriver, configs } = spyFactory();
    const triggerRef = createRef<HTMLButtonElement>();
    const { result } = renderHook(() => useTour({ triggerRef, createDriver }));

    act(() => result.current.startTour());
    expect(hasSeenTour()).toBe(false);

    act(() => configs[0]?.onDestroyed?.());
    expect(hasSeenTour()).toBe(true);
  });

  it("does NOT mark the tour seen when onDestroyed fires from a cleanup-suppressed unmount", () => {
    const { createDriver } = spyFactory();
    const triggerRef = createRef<HTMLButtonElement>();
    const { result, unmount } = renderHook(() => useTour({ triggerRef, createDriver }));

    act(() => result.current.startTour());
    unmount(); // cleanup calls destroy(), which fires the captured onDestroyed

    expect(hasSeenTour()).toBe(false);
  });

  it("a later manual dismissal after a suppressed unmount still marks seen normally (the suppression flag is one-shot)", () => {
    // Guards against a suppression flag that, once set, never clears: a second, real
    // dismissal on a FRESH hook instance must still record seen.
    const { createDriver: firstFactory } = spyFactory();
    const triggerRef = createRef<HTMLButtonElement>();
    const first = renderHook(() => useTour({ triggerRef, createDriver: firstFactory }));
    act(() => first.result.current.startTour());
    first.unmount();
    expect(hasSeenTour()).toBe(false);

    const { createDriver: secondFactory, configs } = spyFactory();
    const second = renderHook(() => useTour({ triggerRef, createDriver: secondFactory }));
    act(() => second.result.current.startTour());
    act(() => configs[0]?.onDestroyed?.());
    expect(hasSeenTour()).toBe(true);
  });

  it("restores focus to the trigger element after onDestroyed returns, not synchronously inside it", async () => {
    const { createDriver, configs } = spyFactory();
    const trigger = document.createElement("button");
    document.body.append(trigger);
    const triggerRef = { current: trigger };
    const { result } = renderHook(() => useTour({ triggerRef, createDriver }));

    act(() => result.current.startTour());
    const focusSpy = vi.spyOn(trigger, "focus");

    act(() => configs[0]?.onDestroyed?.());
    // Not yet: the restore is deferred to a microtask so driver.js's own post-onDestroyed
    // focus handling (on the element it saved) runs first without being clobbered.
    expect(focusSpy).not.toHaveBeenCalled();

    await act(async () => {
      await Promise.resolve();
    });
    expect(focusSpy).toHaveBeenCalledTimes(1);

    trigger.remove();
  });

  it("a rapid second onNextClick supersedes a pending drawer-open move: only the surviving transition reaches the driver (Codex §6 fix 3, navGenerationRef)", async () => {
    vi.useFakeTimers();
    try {
      // Seed "seen" so the auto-start effect's own deferred setTimeout(fn, 0) never
      // competes with this test's manual startTour() call once fake time advances.
      markTourSeen();
      const { createDriver, configs, instances } = spyFactory();
      const triggerRef = createRef<HTMLButtonElement>();
      const openDrawer = vi.fn();
      const closeDrawer = vi.fn();
      const { result } = renderHook(() =>
        useTour({ triggerRef, createDriver, openDrawer, closeDrawer }),
      );

      act(() => result.current.startTour());
      const instance = instances[0];
      expect(instance).toBeDefined();
      if (instance === undefined) {
        return;
      }
      // Sitting on step 0 (map): step 1 (chaos) is the drawer step, so a Next from
      // here opens the drawer and waits.
      instance.getActiveIndex = () => 0;
      const moveNextSpy = vi.spyOn(instance, "moveNext");

      // No `[data-tour="chaos"]` anchor is mounted (this is a controller-only test), so
      // add one now: both waits below then resolve on their very first poll tick,
      // landing at (about) the same time — the exact race `navGenerationRef` guards.
      const chaosAnchor = document.createElement("div");
      chaosAnchor.setAttribute("data-tour", "chaos");
      document.body.append(chaosAnchor);

      act(() => configs[0]?.onNextClick?.()); // map -> chaos: opens the drawer, starts waiting
      act(() => configs[0]?.onNextClick?.()); // a rapid second Next supersedes the first wait

      await act(async () => {
        await vi.advanceTimersByTimeAsync(16); // both waits' first poll tick
      });

      expect(openDrawer).toHaveBeenCalledTimes(2);
      // Only the SURVIVING (second) transition ever reaches the driver: the first
      // transition's `move()` bails because `navGenerationRef` no longer matches the
      // token it captured when it started.
      expect(moveNextSpy).toHaveBeenCalledTimes(1);

      chaosAnchor.remove();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a reversal during a pending drawer-entry closes the drawer instead of stranding it open (Codex §6 loop-2)", async () => {
    vi.useFakeTimers();
    try {
      markTourSeen(); // keep the auto-start deferred task from competing with this test
      const { createDriver, configs, instances } = spyFactory();
      const triggerRef = createRef<HTMLButtonElement>();
      const openDrawer = vi.fn();
      const closeDrawer = vi.fn();
      const { result } = renderHook(() =>
        useTour({ triggerRef, createDriver, openDrawer, closeDrawer }),
      );

      act(() => result.current.startTour());
      const instance = instances[0];
      expect(instance).toBeDefined();
      if (instance === undefined) {
        return;
      }
      instance.getActiveIndex = () => 0; // sitting on step 0 (map)

      // Next (map -> chaos) opens the drawer and starts waiting for its anchor.
      const chaosAnchor = document.createElement("div");
      chaosAnchor.setAttribute("data-tour", "chaos");
      document.body.append(chaosAnchor);
      act(() => configs[0]?.onNextClick?.());
      expect(openDrawer).toHaveBeenCalledTimes(1);

      // A reversal (Previous) BEFORE the entry commits: the destination does not want the
      // drawer, but this session opened it, so the tour must close it, not leave it open.
      act(() => configs[0]?.onPrevClick?.());
      chaosAnchor.remove(); // model the drawer closing: the anchor leaves the DOM

      await act(async () => {
        await vi.advanceTimersByTimeAsync(16);
      });

      // The fix: navigation closes the drawer based on the destination step, so the
      // reversal closes it. Without `drawerOpenRef`, `from` (the map, not a drawer step)
      // would make this a plain move and the drawer would stay open.
      expect(closeDrawer).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// GH132-PLAN.md M3: the auto-start-on-first-load effect. `beforeEach` above already
// clears localStorage and resets the module-level session guard, so every test here
// starts from "unseen, never auto-started".
describe("useTour auto-start (GH132-PLAN.md M3)", () => {
  it("starts the tour once on first load when the tour is unseen", async () => {
    const { createDriver, instances } = spyFactory();
    const triggerRef = createRef<HTMLButtonElement>();
    renderHook(() => useTour({ triggerRef, createDriver }));

    await flushDeferredAutoStart();

    expect(createDriver).toHaveBeenCalledTimes(1);
    expect(instances[0]?.driveCalls).toBe(1);
  });

  it("does not auto-start when hasSeenTour() already reads true at mount", async () => {
    markTourSeen();
    const { createDriver } = spyFactory();
    const triggerRef = createRef<HTMLButtonElement>();
    renderHook(() => useTour({ triggerRef, createDriver }));

    await flushDeferredAutoStart();

    expect(createDriver).not.toHaveBeenCalled();
  });

  it("a Strict Mode setup/teardown/setup cancels the first deferred start without marking seen, and the surviving setup starts exactly once", async () => {
    const { createDriver, instances } = spyFactory();
    const triggerRef = createRef<HTMLButtonElement>();
    renderHook(() => useTour({ triggerRef, createDriver }), { wrapper: StrictMode });

    await flushDeferredAutoStart();

    // Exactly one instance was ever built and driven: the first Strict Mode setup's
    // deferred task was cancelled by its own cleanup before it could fire, so only
    // the surviving setup's timeout actually called startTour().
    expect(createDriver).toHaveBeenCalledTimes(1);
    expect(instances[0]?.driveCalls).toBe(1);
    // The surviving tour is still running (no onDestroyed yet), so nothing marks it
    // seen from the cancelled first setup's teardown.
    expect(hasSeenTour()).toBe(false);
  });

  it("a Strict Mode setup/teardown/setup still marks the tour seen on the surviving tour's real dismissal (Codex §6 fix 1)", async () => {
    // Guards against the cancelled FIRST setup's cleanup arming `suppressSeenRef` even
    // though it never had a live driver to destroy: that would leave the flag armed
    // for the SURVIVING setup's own instance, and its later real dismissal (Done,
    // close, Escape, or backdrop) would skip `markTourSeen()` — the tour would then
    // re-auto-start on every reload.
    const { createDriver, configs, instances } = spyFactory();
    const triggerRef = createRef<HTMLButtonElement>();
    renderHook(() => useTour({ triggerRef, createDriver }), { wrapper: StrictMode });

    await flushDeferredAutoStart();

    expect(instances).toHaveLength(1); // the surviving setup's own tour
    expect(hasSeenTour()).toBe(false);

    act(() => configs[0]?.onDestroyed?.()); // a real dismissal, not the unmount cleanup's destroy()

    expect(hasSeenTour()).toBe(true);
  });

  it("a blocked-storage session still auto-starts at most once, across a from-scratch remount", async () => {
    // hasSeenTour() always reads false here (finding 9): a blocked read, not a real
    // "never seen" state. The module-level session guard is what still caps this at
    // one auto-start, since a fresh hook instance's own state can't remember the first.
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const triggerRef = createRef<HTMLButtonElement>();

    const first = spyFactory();
    const firstRender = renderHook(() => useTour({ triggerRef, createDriver: first.createDriver }));
    await flushDeferredAutoStart();
    expect(first.createDriver).toHaveBeenCalledTimes(1);
    firstRender.unmount();

    const second = spyFactory();
    renderHook(() => useTour({ triggerRef, createDriver: second.createDriver }));
    await flushDeferredAutoStart();
    expect(second.createDriver).not.toHaveBeenCalled();
  });
});

// GH137-PLAN.md M3: the tour footer's shortcut hint (`← → move · Esc exit`).
// driver.js renders its own popover DOM entirely outside React (module doc,
// driver-factory.ts), so `onPopoverRender` is how `use-tour.ts` reaches it; these
// tests fire that hook directly against a bare-DOM footer node, the same way real
// driver.js would call it once per step.
describe("useTour popover shortcut hint (GH137-PLAN.md M3)", () => {
  it("passes an onPopoverRender that appends the shortcut hint's decorative glyph row to the step's footer", () => {
    const { createDriver, configs } = spyFactory();
    const triggerRef = createRef<HTMLButtonElement>();
    const { result } = renderHook(() => useTour({ triggerRef, createDriver }));

    act(() => result.current.startTour());

    const footer = document.createElement("div");
    configs[0]?.onPopoverRender?.({ footer });

    const hint = footer.querySelector(".shortcut-hint");
    expect(hint).not.toBeNull();
    // The visible glyph row, scoped past the visually-hidden accessible label added
    // below it (code review fix 3) so this assertion still pins the exact sighted
    // layout ("← → move · Esc exit") on its own.
    const glyphRow = hint?.querySelector(":scope > [aria-hidden='true']");
    expect(glyphRow?.textContent).toBe("← → move · Esc exit");
  });

  it("renders the hint's keys as aria-hidden .kbd badges inside an aria-hidden glyph row, not plain text", () => {
    const { createDriver, configs } = spyFactory();
    const triggerRef = createRef<HTMLButtonElement>();
    const { result } = renderHook(() => useTour({ triggerRef, createDriver }));

    act(() => result.current.startTour());

    const footer = document.createElement("div");
    configs[0]?.onPopoverRender?.({ footer });

    const badges = footer.querySelectorAll(".shortcut-hint kbd.kbd");
    expect(badges).toHaveLength(3); // ←, →, Esc
    for (const badge of badges) {
      expect(badge.getAttribute("aria-hidden")).toBe("true");
      expect(badge.closest("[aria-hidden='true']")).not.toBeNull();
    }
  });

  // Code review fix 3: the decorative row above is entirely aria-hidden (every <kbd>,
  // now also its own wrapper), so a screen reader used to hear only the plain text
  // sitting next to those badges — "move ... exit" — naming no keys at all. This
  // visually-hidden span (the same `.visually-hidden` class the rest of the app uses)
  // carries the real accessible text instead, without changing what a sighted player
  // sees (the glyph row above is unchanged).
  it("names the arrow keys and Escape in a visually-hidden span, for a screen reader", () => {
    const { createDriver, configs } = spyFactory();
    const triggerRef = createRef<HTMLButtonElement>();
    const { result } = renderHook(() => useTour({ triggerRef, createDriver }));

    act(() => result.current.startTour());

    const footer = document.createElement("div");
    configs[0]?.onPopoverRender?.({ footer });

    const hidden = footer.querySelector(".shortcut-hint .visually-hidden");
    expect(hidden).not.toBeNull();
    expect(hidden?.hasAttribute("aria-hidden")).toBe(false);
    expect(hidden?.textContent).toBe("Left and right arrow keys to move, Escape to exit");
  });

  it("appends a fresh hint to each step's own footer, without disturbing existing footer content", () => {
    const { createDriver, configs } = spyFactory();
    const triggerRef = createRef<HTMLButtonElement>();
    const { result } = renderHook(() => useTour({ triggerRef, createDriver }));

    act(() => result.current.startTour());

    const footer = document.createElement("div");
    const existingButton = document.createElement("button");
    footer.append(existingButton);
    configs[0]?.onPopoverRender?.({ footer });

    expect(footer.contains(existingButton)).toBe(true);
    expect(footer.querySelectorAll(".shortcut-hint")).toHaveLength(1);
  });
});

// GH137-PLAN.md: `tourOwnsKeyboardRef` is the synchronous flag the shortcuts
// dispatcher's bail check #1 reads (`use-shortcuts.tsx`). `App` owns the ref and hands
// it to both the provider and this hook; `useTour` is the one that flips it.
describe("useTour tourOwnsKeyboardRef (GH137-PLAN.md)", () => {
  it("sets it true before drive() and clears it once onDestroyed fires (a real dismissal)", () => {
    const { createDriver, configs } = spyFactory();
    const triggerRef = createRef<HTMLButtonElement>();
    const tourOwnsKeyboardRef = { current: false };
    const { result } = renderHook(() => useTour({ triggerRef, createDriver, tourOwnsKeyboardRef }));

    act(() => result.current.startTour());
    expect(tourOwnsKeyboardRef.current).toBe(true);

    act(() => configs[0]?.onDestroyed?.());
    expect(tourOwnsKeyboardRef.current).toBe(false);
  });

  it("clears it on an unmount that never fired a real dismissal", () => {
    const { createDriver } = spyFactory();
    const triggerRef = createRef<HTMLButtonElement>();
    const tourOwnsKeyboardRef = { current: false };
    const { result, unmount } = renderHook(() =>
      useTour({ triggerRef, createDriver, tourOwnsKeyboardRef }),
    );

    act(() => result.current.startTour());
    expect(tourOwnsKeyboardRef.current).toBe(true);

    unmount(); // cleanup calls destroy(), which fires the captured onDestroyed too
    expect(tourOwnsKeyboardRef.current).toBe(false);
  });

  it("never throws when tourOwnsKeyboardRef is omitted", () => {
    const { createDriver, configs } = spyFactory();
    const triggerRef = createRef<HTMLButtonElement>();
    const { result } = renderHook(() => useTour({ triggerRef, createDriver }));

    expect(() => {
      act(() => result.current.startTour());
      act(() => configs[0]?.onDestroyed?.());
    }).not.toThrow();
  });

  // Code review finding (MAJOR): a throw from `createDriver()`/`instance.drive()` used
  // to leave `tourOwnsKeyboardRef.current` stuck `true` forever — driver.js never got
  // a chance to run its own keyboard handling, and the shortcuts dispatcher's bail
  // check #1 would suppress every mnemonic for the rest of the session. `startTour`
  // must reset to the same state an unmount/onDestroyed would leave: the ref cleared,
  // `active` false, and the session/driver refs reset, then rethrow so the caller still
  // learns about the failure.
  it("a factory whose drive() throws leaves tourOwnsKeyboardRef.current false and active false", () => {
    const triggerRef = createRef<HTMLButtonElement>();
    const tourOwnsKeyboardRef = { current: false };
    const throwingCreateDriver: TourDriverFactory = () => ({
      drive() {
        throw new Error("drive() boom");
      },
      destroy() {},
      moveNext() {},
      movePrevious() {},
      moveTo() {},
      getActiveIndex() {
        return 0;
      },
    });
    const { result } = renderHook(() =>
      useTour({ triggerRef, createDriver: throwingCreateDriver, tourOwnsKeyboardRef }),
    );

    expect(() => act(() => result.current.startTour())).toThrow("drive() boom");

    expect(tourOwnsKeyboardRef.current).toBe(false);
    expect(result.current.active).toBe(false);
  });

  it("a factory that itself throws (before drive()) also leaves the ref/active reset", () => {
    const triggerRef = createRef<HTMLButtonElement>();
    const tourOwnsKeyboardRef = { current: false };
    const throwingFactory: TourDriverFactory = () => {
      throw new Error("createDriver boom");
    };
    const { result } = renderHook(() =>
      useTour({ triggerRef, createDriver: throwingFactory, tourOwnsKeyboardRef }),
    );

    expect(() => act(() => result.current.startTour())).toThrow("createDriver boom");

    expect(tourOwnsKeyboardRef.current).toBe(false);
    expect(result.current.active).toBe(false);
  });

  it("a later, real startTour still works after a prior failed start (session/driver refs reset)", () => {
    const triggerRef = createRef<HTMLButtonElement>();
    const tourOwnsKeyboardRef = { current: false };
    let shouldThrow = true;
    const flakyFactory: TourDriverFactory = (config) => {
      if (shouldThrow) {
        throw new Error("first attempt boom");
      }
      return fakeDriverInstance(config);
    };
    const { result } = renderHook(() =>
      useTour({ triggerRef, createDriver: flakyFactory, tourOwnsKeyboardRef }),
    );

    expect(() => act(() => result.current.startTour())).toThrow();
    shouldThrow = false;

    act(() => result.current.startTour());
    expect(tourOwnsKeyboardRef.current).toBe(true);
    expect(result.current.active).toBe(true);
  });

  it("a failed start whose destroy() also throws still resets ownership and rethrows the original drive() error", () => {
    const triggerRef = createRef<HTMLButtonElement>();
    const tourOwnsKeyboardRef = { current: false };
    const throwingBothFactory: TourDriverFactory = () => ({
      drive() {
        throw new Error("drive() boom");
      },
      destroy() {
        throw new Error("destroy() boom");
      },
      moveNext() {},
      movePrevious() {},
      moveTo() {},
      getActiveIndex() {
        return 0;
      },
    });
    const { result } = renderHook(() =>
      useTour({ triggerRef, createDriver: throwingBothFactory, tourOwnsKeyboardRef }),
    );

    // The original drive() error propagates (the swallowed destroy() failure never masks
    // it), and keyboard ownership is still released.
    expect(() => act(() => result.current.startTour())).toThrow("drive() boom");
    expect(tourOwnsKeyboardRef.current).toBe(false);
    expect(result.current.active).toBe(false);
  });

  it("clears keyboard ownership from onDestroyed even when closeDrawer throws (Codex review: internal state resets before the external callback)", () => {
    const triggerRef = createRef<HTMLButtonElement>();
    const tourOwnsKeyboardRef = { current: false };
    const closeDrawer = () => {
      throw new Error("closeDrawer boom");
    };
    const { createDriver, configs } = spyFactory();
    const { result } = renderHook(() =>
      useTour({ triggerRef, createDriver, closeDrawer, tourOwnsKeyboardRef }),
    );

    act(() => result.current.startTour());
    expect(tourOwnsKeyboardRef.current).toBe(true);

    // onDestroyed runs closeDrawer LAST and guarded, so its throw cannot leave the
    // shortcuts dispatcher permanently bailed.
    act(() => configs[0]?.onDestroyed?.());

    expect(tourOwnsKeyboardRef.current).toBe(false);
    expect(result.current.active).toBe(false);
  });
});
