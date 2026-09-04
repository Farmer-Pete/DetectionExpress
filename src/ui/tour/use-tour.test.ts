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
import type { TourDriverConfig, TourDriverInstance } from "./driver-factory";
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
