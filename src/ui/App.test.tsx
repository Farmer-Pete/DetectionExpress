import { act, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { referenceSource } from "../game/engine-source";
import { defaultEntry } from "../game/registry";
import type { RunController } from "../game/run-controller";
import { useGameStore } from "../game/store";
import { emptySnapshot, type SimSnapshot } from "../sim/snapshot";
import type { WorldLogEvent } from "../sim/world-log";
import { App } from "./App";
import { hireMe, liveScenarioFrom } from "./content/narrative";
import { hasSeenTour, markTourSeen } from "./onboarding-storage";
import type { TourDriverConfig, TourDriverInstance } from "./tour/driver-factory";
import { resetTourAutoStartForTests } from "./tour/use-tour";

const liveScenario = liveScenarioFrom(defaultEntry);

// The zustand store is a singleton shared across test files, so reset the fields
// this file reads before each test. Mirrors the reset pattern in store.test.ts.
//
// The guided tour auto-starts on first load (GH132-PLAN.md M3). Shell tests seed the
// tour's seen flag so it never fires; the dedicated auto-start tests below clear it.
beforeEach(() => {
  useGameStore.setState({
    source: referenceSource,
    runPending: false,
    transport: { frozen: false, speed: 1 },
    overlayOpen: false,
    selection: null,
    decisionSelection: null,
    mapDialogStack: [],
    snapshot: emptySnapshot(),
  });
  markTourSeen();
  resetTourAutoStartForTests();
});

/** Clicks the hamburger: opens the side panel on whatever tab was last active
 *  (chaos, by default). GH132-PLAN.md M1 (design revision): the hamburger no
 *  longer opens a popup — it opens the panel directly. */
function openPanel(): void {
  fireEvent.click(screen.getByRole("button", { name: /side panel/i }));
}

/** Opens the panel (via the hamburger) and switches it to the named tab. */
function openPanelOnTab(name: RegExp): void {
  openPanel();
  fireEvent.click(screen.getByRole("tab", { name }));
}

/** Starts the guided tour from the side panel's Options tab (GH132-PLAN.md M2,
 *  replacing M1's "How this works" intro-reopen). This closes the panel first, then
 *  the tour starts once the panel has actually unmounted — see App.tsx's "The
 *  start-tour transition". */
function startTourFromOptions(): void {
  openPanelOnTab(/options/i);
  fireEvent.click(screen.getByRole("button", { name: "Retake tour" }));
}

/** A fake driver.js instance for the App-level tour tests: records `drive()` and, on
 *  `destroy()`, fires the `onDestroyed` callback it was built with — the same
 *  programmatic-destroy path `tour/use-tour.test.ts`'s own fake exercises. */
function fakeTourDriver(config: TourDriverConfig): TourDriverInstance & { driveCalls: number } {
  let driveCalls = 0;
  return {
    get driveCalls() {
      return driveCalls;
    },
    drive() {
      driveCalls += 1;
    },
    destroy() {
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

/** A spy driver.js factory: records every config it was built with, so a test can
 *  reach into the built steps or fire `onDestroyed` directly. */
function fakeTourDriverFactory() {
  const configs: TourDriverConfig[] = [];
  const instances: ReturnType<typeof fakeTourDriver>[] = [];
  const createDriver = vi.fn((config: TourDriverConfig) => {
    configs.push(config);
    const instance = fakeTourDriver(config);
    instances.push(instance);
    return instance;
  });
  return { createDriver, configs, instances };
}

/** A fare-gate world-log event at Central (`cen`), for the log-row-click tests below. */
function fareGateEvent(id: number): WorldLogEvent {
  return {
    id,
    ts: id * 2,
    sensor: "fare-gate",
    placeId: "cen",
    chipNode: "cen:gate",
    reading: {
      sensor: "fare-gate",
      reading: {
        ts: id * 2,
        card: `card-${id}`,
        station: "cen",
        line: "red",
        direction: "in",
        result: "ok",
        balance: 50,
      },
    },
    scored: false,
  };
}

/** A no-op controller so the test never touches the real loader or engine. */
function stubController(): RunController & {
  runs: number;
  disposes: number;
  frozenCalls: boolean[];
  speedCalls: number[];
} {
  let runs = 0;
  let disposes = 0;
  const frozenCalls: boolean[] = [];
  const speedCalls: number[] = [];
  return {
    get runs() {
      return runs;
    },
    get disposes() {
      return disposes;
    },
    frozenCalls,
    speedCalls,
    run() {
      runs += 1;
    },
    setFrozen(frozen: boolean) {
      frozenCalls.push(frozen);
    },
    setSpeed(speed) {
      speedCalls.push(speed);
    },
    triggerWave() {
      return null;
    },
    setChaosLevel() {},
    dispose() {
      disposes += 1;
    },
  };
}

describe("App shell", () => {
  it("renders the heading", () => {
    render(<App createPipelineController={() => stubController()} />);
    const heading = screen.getByRole("heading", { name: "Detection Express" });
    expect(heading.textContent).toBe("Detection Express");
  });

  it("renders no run-status pill (GH132-PLAN.md M2: the RUNNING badge is gone)", () => {
    const { container } = render(<App createPipelineController={() => stubController()} />);
    expect(container.querySelector(".status-pill")).toBeNull();
  });

  it("has no gauge strip on screen at rest: the Metrics UI is retired for now, though the sim still computes the values", () => {
    render(<App createPipelineController={() => stubController()} />);
    expect(screen.queryByText("Throughput")).toBeNull();
    expect(screen.queryByText("Queue")).toBeNull();
  });

  it("has no Metrics opener in the Topbar", () => {
    render(<App createPipelineController={() => stubController()} />);
    expect(screen.queryByRole("button", { name: "Metrics" })).toBeNull();
  });

  it("has no dev chaos-wave trigger button (GH126-PLAN.md M3b retires it)", () => {
    render(<App createPipelineController={() => stubController()} />);
    expect(screen.queryByRole("button", { name: /trigger chaos wave/i })).toBeNull();
  });

  it("renders no won/lost end screen, even once the run concludes (GH126-PLAN.md M3b retires it)", () => {
    useGameStore.setState({ snapshot: { ...emptySnapshot(), status: "won" } });
    render(<App createPipelineController={() => stubController()} />);
    expect(screen.queryByText(/simulation ended/i)).toBeNull();
  });

  it("has no side panel on screen at rest", () => {
    render(<App createPipelineController={() => stubController()} />);
    expect(screen.queryByRole("dialog", { name: "Side panel" })).toBeNull();
  });

  it("opens the side panel on the chaos tab, chaos ladder default, from the hamburger button", () => {
    render(<App createPipelineController={() => stubController()} />);
    openPanel();
    expect(screen.getByRole("dialog", { name: "Side panel" })).toBeDefined();
    expect(screen.getByRole("tab", { name: /chaos/i }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("heading", { name: /chaos ladder/i })).toBeDefined();
    expect(screen.getByText(new RegExp(liveScenario.displayName))).toBeDefined();
  });

  it("opens the side panel on the algorithm tab, with Apply and Reset, from the hamburger button then the Algorithm tab", () => {
    render(<App createPipelineController={() => stubController()} />);
    openPanelOnTab(/algorithm/i);
    expect(screen.getByRole("tab", { name: /algorithm/i }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(screen.getByRole("button", { name: "Apply" })).toBeDefined();
    expect(screen.getByRole("button", { name: /reset to default/i })).toBeDefined();
  });

  it("runs the controller on mount and disposes it on unmount", () => {
    const controller = stubController();
    const { unmount } = render(<App createPipelineController={() => controller} />);
    expect(controller.runs).toBe(1);
    unmount();
    expect(controller.disposes).toBe(1);
  });

  it("carries the Hire Me button and the hamburger button in the topbar", () => {
    render(<App createPipelineController={() => stubController()} />);
    expect(screen.getByRole("button", { name: hireMe.heading })).toBeDefined();
    expect(screen.getByRole("button", { name: /side panel/i })).toBeDefined();
  });

  it("reflects the store frozen state into the controller on mount", () => {
    useGameStore.setState({ transport: { frozen: true, speed: 1 } });
    const controller = stubController();
    render(<App createPipelineController={() => controller} />);
    expect(controller.frozenCalls).toContain(true);
  });

  it("reflects the store speed into the controller on mount", () => {
    useGameStore.setState({ transport: { frozen: false, speed: 2 } });
    const controller = stubController();
    render(<App createPipelineController={() => controller} />);
    expect(controller.speedCalls).toContain(2);
  });

  it("mounts the inspector shell and no React Flow canvas", () => {
    const { container } = render(<App createPipelineController={() => stubController()} />);
    expect(screen.getByRole("region", { name: "Inspector" })).toBeDefined();
    // The React Flow canvas is gone: its root wrapper class must be absent.
    expect(container.querySelector(".react-flow")).toBeNull();
    expect(container.querySelector(".pipeline")).toBeNull();
  });

  it("mounts the decisions panel directly under the inspector shell (T10)", () => {
    const { container } = render(<App createPipelineController={() => stubController()} />);
    const inspector = screen.getByRole("region", { name: "Inspector" });
    const decisions = screen.getByRole("region", { name: "Decisions" });
    expect(decisions).toBeDefined();
    // "Directly under": the decisions panel is the inspector shell's next sibling.
    expect(inspector.nextElementSibling).toBe(decisions);
    expect(container.contains(decisions)).toBe(true);
  });
});

describe("App side panel (GH118-PLAN.md)", () => {
  it("inerts the shell while the side panel is open, and lifts it on close", () => {
    render(<App createPipelineController={() => stubController()} />);
    openPanel();
    const shell = document.querySelector(".app-shell");
    expect(shell?.hasAttribute("inert")).toBe(true);

    fireEvent.keyDown(screen.getByRole("dialog", { name: "Side panel" }), { key: "Escape" });
    expect(shell?.hasAttribute("inert")).toBe(false);
    expect(screen.queryByRole("dialog", { name: "Side panel" })).toBeNull();
  });

  it("publishes overlayOpen true/false as the panel opens and closes, and resets it false on unmount", () => {
    const { unmount } = render(<App createPipelineController={() => stubController()} />);
    expect(useGameStore.getState().overlayOpen).toBe(false);

    openPanel();
    expect(useGameStore.getState().overlayOpen).toBe(true);

    fireEvent.keyDown(screen.getByRole("dialog", { name: "Side panel" }), { key: "Escape" });
    expect(useGameStore.getState().overlayOpen).toBe(false);

    openPanel();
    expect(useGameStore.getState().overlayOpen).toBe(true);
    unmount();
    expect(useGameStore.getState().overlayOpen).toBe(false);
  });

  it("publishes overlayOpen in the same commit the shell goes inert (useLayoutEffect, not a lagging passive effect)", () => {
    render(<App createPipelineController={() => stubController()} />);
    // Record whether the shell is already inert at the instant the store notifies
    // subscribers of an overlayOpen flip, the same "ordering, not just the end
    // state" rigor as App.browse-isolation.test.tsx's inert-at-focus-time check: a
    // passive effect would still reach the right end state, but could notify one
    // task later than the DOM mutation, which this catches.
    const inertAtPublish: Array<boolean | undefined> = [];
    const unsubscribe = useGameStore.subscribe((state, prevState) => {
      if (state.overlayOpen !== prevState.overlayOpen) {
        inertAtPublish.push(document.querySelector(".app-shell")?.hasAttribute("inert"));
      }
    });
    openPanel();
    unsubscribe();
    expect(inertAtPublish).toEqual([true]);
  });

  it("opens the panel from the hamburger button, then the Algorithm tab", () => {
    render(<App createPipelineController={() => stubController()} />);
    openPanelOnTab(/algorithm/i);
    expect(screen.getByRole("tab", { name: /algorithm/i }).getAttribute("aria-selected")).toBe(
      "true",
    );
  });
});

describe("App place dialog (GH124-PLAN.md Checkpoint 4)", () => {
  it("opens a station's place dialog on click, inerts the shell, and does not freeze the engine", () => {
    const controller = stubController();
    render(<App createPipelineController={() => controller} />);
    fireEvent.click(screen.getByRole("button", { name: "Central" }));

    expect(screen.getByRole("dialog", { name: "Central" })).toBeDefined();
    expect(document.querySelector(".app-shell")?.hasAttribute("inert")).toBe(true);
    expect(useGameStore.getState().transport.frozen).toBe(false);
    expect(controller.frozenCalls).not.toContain(true);
  });

  it("Escape closes the place dialog and lifts the shell's inert state", () => {
    render(<App createPipelineController={() => stubController()} />);
    fireEvent.click(screen.getByRole("button", { name: "Central" }));
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Central" }), { key: "Escape" });

    expect(screen.queryByRole("dialog", { name: "Central" })).toBeNull();
    expect(document.querySelector(".app-shell")?.hasAttribute("inert")).toBe(false);
    expect(useGameStore.getState().mapDialogStack).toEqual([]);
  });

  it("re-renders the open dialog live as the snapshot changes, unlike the frozen trace/side-panel overlays", () => {
    render(<App createPipelineController={() => stubController()} />);
    fireEvent.click(screen.getByRole("button", { name: "Central" }));

    act(() => {
      useGameStore.setState({
        snapshot: {
          ...emptySnapshot(),
          actors: [
            {
              id: "R1",
              kind: "rider",
              presence: { kind: "at", node: "cen", fromTick: 0, untilTick: 10 },
            },
          ],
        },
      });
    });

    // The aggregated ACTORS table (GH124-PLAN.md Checkpoint 4 Part 4) shows the
    // activity phrase and a count, never a raw actor id.
    expect(screen.getByText("waiting for a train")).toBeDefined();
  });

  it("is mutually exclusive with the side panel: a map click while it is open never also opens the place dialog", () => {
    render(<App createPipelineController={() => stubController()} />);
    openPanel();
    expect(screen.getByRole("dialog", { name: "Side panel" })).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Central" }));

    expect(screen.queryByRole("dialog", { name: "Central" })).toBeNull();
    expect(useGameStore.getState().mapDialogStack).toEqual([]);
    expect(screen.getByRole("dialog", { name: "Side panel" })).toBeDefined();
  });

  it("is mutually exclusive with the trace dialog: a map click while a finding/decision is selected never also opens the place dialog", () => {
    render(<App createPipelineController={() => stubController()} />);
    act(() => {
      useGameStore.setState({ selection: { seq: 1 } });
    });

    fireEvent.click(screen.getByRole("button", { name: "Central" }));

    expect(useGameStore.getState().mapDialogStack).toEqual([]);
  });
});

// The event opener (a LogPanel row click) is guarded the same way the map opener
// (onMapSelect) already was, closing the asymmetry a Codex review flagged: before
// this fix, a log-row click routed straight to the store's selectWorldEvent with no
// App-level guard at all, so it could stack the event dialog on top of the side panel
// or the place dialog even though the map opener already blocked the equivalent case.
describe("App event dialog opener guard (GH124-PLAN.md Checkpoint 5, consistency fix)", () => {
  it("is mutually exclusive with the side panel: a log-row click while it is open never also opens the event dialog", () => {
    render(<App createPipelineController={() => stubController()} />);
    act(() => {
      useGameStore.setState({ snapshot: { ...emptySnapshot(), worldEvents: [fareGateEvent(5)] } });
    });
    openPanel();
    expect(screen.getByRole("dialog", { name: "Side panel" })).toBeDefined();

    fireEvent.click(screen.getByTestId("log-row-5"));

    expect(useGameStore.getState().mapDialogStack).toEqual([]);
    expect(screen.getByRole("dialog", { name: "Side panel" })).toBeDefined();
  });

  it("is mutually exclusive with the place dialog: a log-row click while it is open never also opens the event dialog", () => {
    render(<App createPipelineController={() => stubController()} />);
    act(() => {
      useGameStore.setState({ snapshot: { ...emptySnapshot(), worldEvents: [fareGateEvent(5)] } });
    });
    fireEvent.click(screen.getByRole("button", { name: "Central" }));
    expect(screen.getByRole("dialog", { name: "Central" })).toBeDefined();

    fireEvent.click(screen.getByTestId("log-row-5"));

    // The click is blocked, so the place dialog already on the stack stays exactly
    // as it was — this is NOT a push (a main-log-row click is an "outside" opener,
    // only reachable while the stack starts empty).
    expect(useGameStore.getState().mapDialogStack).toEqual([
      { kind: "place", selection: { kind: "node", id: "cen" } },
    ]);
  });

  it("is mutually exclusive with the trace dialog: a log-row click while a finding/decision is selected never also opens the event dialog", () => {
    render(<App createPipelineController={() => stubController()} />);
    act(() => {
      useGameStore.setState({
        selection: { seq: 1 },
        snapshot: { ...emptySnapshot(), worldEvents: [fareGateEvent(5)] },
      });
    });

    fireEvent.click(screen.getByTestId("log-row-5"));

    expect(useGameStore.getState().mapDialogStack).toEqual([]);
  });

  it("opens the event dialog on a log-row click when no other modal is open", () => {
    render(<App createPipelineController={() => stubController()} />);
    act(() => {
      useGameStore.setState({ snapshot: { ...emptySnapshot(), worldEvents: [fareGateEvent(5)] } });
    });

    fireEvent.click(screen.getByTestId("log-row-5"));

    expect(useGameStore.getState().mapDialogStack).toEqual([{ kind: "event", id: 5 }]);
  });
});

// The navigation stack (GH124 follow-up): the "Open place" link inside EventDialog and
// a scoped-log row inside PlaceDialog used to perform an ATOMIC SWAP — closing the
// dialog the player came from with no way back. They now PUSH onto a shared bounded
// stack instead, so a "‹ Back" control in the newly-topmost dialog returns to the one
// underneath, while the × button always closes the whole stack regardless of depth.
describe("App map/event dialog navigation stack (GH124 follow-up: Back)", () => {
  it("'Open place' inside the event dialog pushes the place dialog on top; Back returns to the event dialog", () => {
    render(<App createPipelineController={() => stubController()} />);
    act(() => {
      useGameStore.setState({ snapshot: { ...emptySnapshot(), worldEvents: [fareGateEvent(5)] } });
    });
    fireEvent.click(screen.getByTestId("log-row-5"));
    expect(useGameStore.getState().mapDialogStack).toEqual([{ kind: "event", id: 5 }]);

    fireEvent.click(screen.getByRole("button", { name: "Open place" }));

    expect(useGameStore.getState().mapDialogStack).toEqual([
      { kind: "event", id: 5 },
      { kind: "place", selection: { kind: "node", id: "cen" } },
    ]);
    expect(screen.getByRole("dialog", { name: "Central" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Back" })).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Back" }));

    expect(useGameStore.getState().mapDialogStack).toEqual([{ kind: "event", id: 5 }]);
    expect(screen.queryByRole("dialog", { name: "Central" })).toBeNull();
    expect(screen.getByRole("dialog")).toBeDefined(); // the event dialog is back
  });

  it("a scoped-log row inside the place dialog pushes the event dialog on top; Back returns to the place dialog", () => {
    render(<App createPipelineController={() => stubController()} />);
    act(() => {
      useGameStore.setState({ snapshot: { ...emptySnapshot(), worldEvents: [fareGateEvent(5)] } });
    });
    fireEvent.click(screen.getByRole("button", { name: "Central" }));
    expect(useGameStore.getState().mapDialogStack).toEqual([
      { kind: "place", selection: { kind: "node", id: "cen" } },
    ]);

    fireEvent.click(screen.getByTestId("place-log-row-5"));

    expect(useGameStore.getState().mapDialogStack).toEqual([
      { kind: "place", selection: { kind: "node", id: "cen" } },
      { kind: "event", id: 5 },
    ]);
    expect(screen.queryByRole("dialog", { name: "Central" })).toBeNull();
    expect(screen.getByRole("button", { name: "Back" })).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Back" }));

    expect(useGameStore.getState().mapDialogStack).toEqual([
      { kind: "place", selection: { kind: "node", id: "cen" } },
    ]);
    expect(screen.getByRole("dialog", { name: "Central" })).toBeDefined();
  });

  it("the × button on a pushed dialog closes the WHOLE stack, not just the top entry, and lifts the shell's inert state", () => {
    render(<App createPipelineController={() => stubController()} />);
    act(() => {
      useGameStore.setState({ snapshot: { ...emptySnapshot(), worldEvents: [fareGateEvent(5)] } });
    });
    fireEvent.click(screen.getByTestId("log-row-5"));
    fireEvent.click(screen.getByRole("button", { name: "Open place" }));
    expect(useGameStore.getState().mapDialogStack).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(useGameStore.getState().mapDialogStack).toEqual([]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.querySelector(".app-shell")?.hasAttribute("inert")).toBe(false);
  });

  it("Back moves focus into the now-topmost dialog", () => {
    render(<App createPipelineController={() => stubController()} />);
    act(() => {
      useGameStore.setState({ snapshot: { ...emptySnapshot(), worldEvents: [fareGateEvent(5)] } });
    });
    fireEvent.click(screen.getByRole("button", { name: "Central" }));
    fireEvent.click(screen.getByTestId("place-log-row-5"));
    expect(screen.queryByRole("dialog", { name: "Central" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Back" }));

    const placeDialog = screen.getByRole("dialog", { name: "Central" });
    expect(document.activeElement).toBe(placeDialog);
  });

  it("closing the whole stack via × restores focus to the very first (outermost) trigger, across a push", () => {
    render(<App createPipelineController={() => stubController()} />);
    act(() => {
      useGameStore.setState({ snapshot: { ...emptySnapshot(), worldEvents: [fareGateEvent(5)] } });
    });
    // The main log row (a real `<button>`) focuses itself on click (LogPanel.tsx),
    // the same stand-in a real browser click would produce.
    const logRow = screen.getByTestId("log-row-5");
    fireEvent.click(logRow); // opens the event dialog: the root of this session

    fireEvent.click(screen.getByRole("button", { name: "Open place" })); // pushes the place dialog on top
    expect(useGameStore.getState().mapDialogStack).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(useGameStore.getState().mapDialogStack).toEqual([]);
    expect(document.activeElement).toBe(logRow);
  });

  it("restores focus to an SVG station control that rooted the stack, across a push", () => {
    render(<App createPipelineController={() => stubController()} />);
    act(() => {
      useGameStore.setState({ snapshot: { ...emptySnapshot(), worldEvents: [fareGateEvent(5)] } });
    });
    // The map's station control is an SVG `<g>` (MetroMap.tsx). A keyboard user tabs to
    // it, focusing it, then activates it; an `SVGElement` satisfies the widened
    // focus-restore guard, so a full close returns focus here even across a pushed dialog.
    const station = screen.getByRole("button", { name: "Central" });
    station.focus();
    fireEvent.click(station); // opens the place dialog: the root of this session
    expect(document.activeElement).not.toBe(station); // focus moved into the dialog

    fireEvent.click(screen.getByTestId("place-log-row-5")); // pushes the event dialog on top
    expect(useGameStore.getState().mapDialogStack).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(useGameStore.getState().mapDialogStack).toEqual([]);
    expect(document.activeElement).toBe(station);
  });

  it("closing an event-rooted stack that pushed a place restores focus to the event's own fallback (the log panel), not the place dialog's, when the trigger is gone", () => {
    render(<App createPipelineController={() => stubController()} />);
    act(() => {
      useGameStore.setState({ snapshot: { ...emptySnapshot(), worldEvents: [fareGateEvent(5)] } });
    });
    const logRow = screen.getByTestId("log-row-5");
    fireEvent.click(logRow); // opens the event dialog: the root of this session

    fireEvent.click(screen.getByRole("button", { name: "Open place" })); // pushes the place dialog on top
    expect(useGameStore.getState().mapDialogStack).toHaveLength(2);

    logRow.remove(); // the root trigger leaves the DOM while the place dialog is on top

    fireEvent.click(screen.getByRole("button", { name: "Close" })); // closes via the PLACE dialog's × button

    expect(useGameStore.getState().mapDialogStack).toEqual([]);
    // Restores to the EVENT dialog's own fallback (the log panel) — the fallback
    // captured when the event dialog rooted the session — not the PLACE dialog's own
    // fallback (the map region), even though the place dialog is the one that was
    // actually on top, and whose × button was actually clicked, when the stack closed
    // (GH124 follow-up: bug fix).
    expect(document.activeElement).toBe(document.querySelector(".log-panel"));
    expect(document.activeElement).not.toBe(document.querySelector(".metro-map-region"));
  });
});

// GH132-PLAN.md M3: the tour auto-starts on first load, replacing the old intro
// overlay entirely. `beforeEach` above marks the tour seen so unrelated tests never
// see it fire; these tests clear that flag to exercise the real "unseen" path.
describe("App tour auto-start (GH132-PLAN.md M3)", () => {
  /** Flushes the auto-start effect's deferred macrotask (`use-tour.ts`'s
   *  `setTimeout(fn, 0)`). */
  async function flushDeferredAutoStart(): Promise<void> {
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  }

  it("starts the tour once on first load when unseen", async () => {
    localStorage.clear();
    const { createDriver, instances } = fakeTourDriverFactory();
    render(
      <App createPipelineController={() => stubController()} createTourDriver={createDriver} />,
    );

    await flushDeferredAutoStart();

    expect(createDriver).toHaveBeenCalledTimes(1);
    expect(instances[0]?.driveCalls).toBe(1);
  });

  it("does not auto-start when hasSeenTour() is already true", async () => {
    // beforeEach's markTourSeen() already covers this; assert it explicitly.
    const { createDriver } = fakeTourDriverFactory();
    render(
      <App createPipelineController={() => stubController()} createTourDriver={createDriver} />,
    );

    await flushDeferredAutoStart();

    expect(createDriver).not.toHaveBeenCalled();
  });

  it("a Strict Mode setup/teardown/setup cancels the first deferred start without marking seen, and the surviving setup starts exactly once", async () => {
    localStorage.clear();
    const { createDriver, instances } = fakeTourDriverFactory();
    render(
      <StrictMode>
        <App createPipelineController={() => stubController()} createTourDriver={createDriver} />
      </StrictMode>,
    );

    await flushDeferredAutoStart();

    expect(createDriver).toHaveBeenCalledTimes(1);
    expect(instances[0]?.driveCalls).toBe(1);
    expect(hasSeenTour()).toBe(false); // still running: nothing has called onDestroyed
  });

  it("a blocked-storage session still auto-starts at most once, across a from-scratch remount", async () => {
    // A stub whose reads always throw, replacing `localStorage` outright rather than
    // patching `Storage.prototype`: `hasSeenTour()` must see every read as "blocked"
    // regardless of which concrete `Storage` instance/prototype the DOM environment
    // hands out for `globalThis.localStorage`.
    const blockedStorage: Storage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {},
      removeItem: () => {},
      clear: () => {},
      key: () => null,
      length: 0,
    };
    vi.stubGlobal("localStorage", blockedStorage);
    try {
      const first = fakeTourDriverFactory();
      const firstRender = render(
        <App
          createPipelineController={() => stubController()}
          createTourDriver={first.createDriver}
        />,
      );
      await flushDeferredAutoStart();
      expect(first.createDriver).toHaveBeenCalledTimes(1);
      firstRender.unmount();

      const second = fakeTourDriverFactory();
      render(
        <App
          createPipelineController={() => stubController()}
          createTourDriver={second.createDriver}
        />,
      );
      await flushDeferredAutoStart();
      expect(second.createDriver).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// GH132-PLAN.md M2: "Retake tour" replaces M1's "How this works" Options-tab button.
// These tests mirror the removed reopen-intro ones' shape, retargeted at the tour.
// `markTourSeen()` in this file's `beforeEach` keeps the M3 auto-start out of the way
// here, so these only ever exercise the manual, user-triggered `startTour`.
describe("App tour (GH132-PLAN.md M2)", () => {
  it('the Options tab\'s "Retake tour" button closes the panel, then starts the tour once it has actually closed', () => {
    const { createDriver, instances } = fakeTourDriverFactory();
    render(
      <App createPipelineController={() => stubController()} createTourDriver={createDriver} />,
    );

    startTourFromOptions();

    expect(screen.queryByRole("dialog", { name: "Side panel" })).toBeNull();
    expect(createDriver).toHaveBeenCalledTimes(1);
    expect(instances[0]?.driveCalls).toBe(1);
  });

  it("builds one driver.js step per data-tour anchor the tour targets", () => {
    const { createDriver, configs } = fakeTourDriverFactory();
    render(
      <App createPipelineController={() => stubController()} createTourDriver={createDriver} />,
    );

    startTourFromOptions();

    const elements = configs[0]?.steps.map((step) => step.element);
    expect(elements).toContain('[data-tour="map"]');
    expect(elements).toContain('[data-tour="chaos"]');
    expect(elements).toContain('[data-tour="log"]');
    expect(elements).toContain('[data-tour="findings"]');
    expect(elements).toContain('[data-tour="decisions"]');
    expect(elements).toContain('[data-tour="hire"]');
  });

  it("does not inert the shell while the tour drives: it is not a modal, and the sim shell stays live", () => {
    const { createDriver } = fakeTourDriverFactory();
    render(
      <App createPipelineController={() => stubController()} createTourDriver={createDriver} />,
    );

    startTourFromOptions();

    // Not inert: the shell stays interactive so the tour can spotlight live elements.
    expect(document.querySelector(".app-shell")?.hasAttribute("inert")).toBe(false);
    // overlayOpen IS true while the tour runs (GH132-PLAN.md M2, Codex fix 1): it
    // suppresses LogPanel's global Space-to-freeze during the tour, without inerting.
    expect(useGameStore.getState().overlayOpen).toBe(true);
  });

  it("restores focus to the hamburger trigger once the tour ends (the Options button that started it is already gone)", async () => {
    const { createDriver, configs } = fakeTourDriverFactory();
    render(
      <App createPipelineController={() => stubController()} createTourDriver={createDriver} />,
    );
    const hamburgerTrigger = screen.getByRole("button", { name: /side panel/i });

    startTourFromOptions();
    await act(async () => {
      configs[0]?.onDestroyed?.();
      await Promise.resolve();
    });

    expect(document.activeElement).toBe(hamburgerTrigger);
  });

  it("marks the tour seen once it ends", async () => {
    localStorage.clear(); // undo this file's beforeEach markTourSeen(): start unseen
    const { createDriver, configs } = fakeTourDriverFactory();
    render(
      <App createPipelineController={() => stubController()} createTourDriver={createDriver} />,
    );

    startTourFromOptions();
    expect(hasSeenTour()).toBe(false);
    await act(async () => {
      configs[0]?.onDestroyed?.();
      await Promise.resolve();
    });

    expect(hasSeenTour()).toBe(true);
  });

  it('"Retake tour" restores a hidden map, so step 1\'s target exists before the tour starts (Codex §6 fix 2)', () => {
    const { createDriver } = fakeTourDriverFactory();
    render(
      <App createPipelineController={() => stubController()} createTourDriver={createDriver} />,
    );

    openPanelOnTab(/options/i);
    fireEvent.click(screen.getByRole("button", { name: "Hide metro view" }));
    expect(document.querySelector('[data-tour="map"]')).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Retake tour" }));

    expect(document.querySelector('[data-tour="map"]')).not.toBeNull();
    expect(createDriver).toHaveBeenCalledTimes(1);
  });
});

describe("App map toggle (GH117: one engine, the map is a display toggle)", () => {
  it("builds the one pipeline loop on mount", () => {
    const pipes: ReturnType<typeof stubController>[] = [];
    render(
      <App
        createPipelineController={() => {
          const stub = stubController();
          pipes.push(stub);
          return stub;
        }}
      />,
    );
    expect(pipes).toHaveLength(1);
    expect(pipes[0]?.runs).toBe(1);
  });

  it("renders the map region and the inspector shell together, map before the inspector", () => {
    const { container } = render(<App createPipelineController={() => stubController()} />);
    expect(container.querySelector(".metro-view")).not.toBeNull();
    expect(container.querySelector(".inspector-shell")).not.toBeNull();
    // querySelectorAll returns matches in document order, so this list IS the order.
    const classes = [...container.querySelectorAll(".metro-view, .inspector-shell")].map(
      (el) => el.className,
    );
    expect(classes).toEqual(["metro-view", "inspector-shell"]);
  });

  it("shows the map region by default and hides it on toggle, without touching the pipeline loop", () => {
    const pipes: ReturnType<typeof stubController>[] = [];
    render(
      <App
        createPipelineController={() => {
          const stub = stubController();
          pipes.push(stub);
          return stub;
        }}
      />,
    );
    // role="group", not role="img" (GH124-PLAN.md Checkpoint 4): an image's
    // descendants are not exposed as interactive controls, which would make every
    // station/site/train button on the map unreachable to assistive tech.
    expect(screen.getByRole("group", { name: "Metro network map" })).toBeDefined();

    openPanelOnTab(/options/i);
    fireEvent.click(screen.getByRole("button", { name: "Hide metro view" }));
    expect(screen.queryByRole("group", { name: "Metro network map" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Show metro view" }));
    expect(screen.getByRole("group", { name: "Metro network map" })).toBeDefined();

    // Never rebuilt or disposed across either toggle: the one engine keeps running.
    expect(pipes).toHaveLength(1);
    expect(pipes[0]?.disposes).toBe(0);
  });

  it("builds a fresh controller per epoch under strict-mode double invoke", () => {
    const pipes: ReturnType<typeof stubController>[] = [];
    render(
      <StrictMode>
        <App
          createPipelineController={() => {
            const stub = stubController();
            pipes.push(stub);
            return stub;
          }}
        />
      </StrictMode>,
    );
    // Strict mode mounts, unmounts (disposing the first), then remounts a fresh one.
    expect(pipes.length).toBe(2);
    expect(pipes[0]?.disposes).toBe(1);
    expect(pipes[1]?.runs).toBe(1);
    expect(pipes[1]?.disposes).toBe(0);
  });
});

describe("App wave shake (#38 juice item 1)", () => {
  function setWave(wave: SimSnapshot["wave"]): void {
    useGameStore.setState({ snapshot: { ...emptySnapshot(), wave } });
  }

  it("adds .shake to .app-shell on the incoming -> active edge, then clears it", () => {
    vi.useFakeTimers();
    try {
      setWave({ phase: "incoming", index: 0, ticksUntilNext: 1, eventsPerTick: null });
      const { container } = render(<App createPipelineController={() => stubController()} />);
      const shell = container.querySelector(".app-shell");
      expect(shell?.className).not.toMatch(/shake/);

      act(() => {
        setWave({ phase: "active", index: 0, ticksUntilNext: null, eventsPerTick: 5 });
      });
      expect(shell?.className).toMatch(/shake/);

      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(shell?.className).not.toMatch(/shake/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not shake on a rerender that is not an incoming -> active edge", () => {
    setWave({ phase: "calm", index: 0, ticksUntilNext: 10, eventsPerTick: null });
    const { container } = render(<App createPipelineController={() => stubController()} />);
    const shell = container.querySelector(".app-shell");
    act(() => {
      setWave({ phase: "incoming", index: 0, ticksUntilNext: 5, eventsPerTick: null });
    });
    expect(shell?.className).not.toMatch(/shake/);
  });

  it("shakes .app-shell, not an open overlay's ancestor, so the overlay escapes it (F006)", () => {
    vi.useFakeTimers();
    try {
      setWave({ phase: "incoming", index: 0, ticksUntilNext: 1, eventsPerTick: null });
      const { container } = render(<App createPipelineController={() => stubController()} />);
      openPanel(); // show an overlay (the side panel) so it is on screen while .app-shell shakes
      const shell = container.querySelector(".app-shell");
      const overlay = container.querySelector(".sidepanel-backdrop");
      expect(overlay).not.toBeNull();

      act(() => {
        setWave({ phase: "active", index: 0, ticksUntilNext: null, eventsPerTick: 5 });
      });
      expect(shell?.className).toMatch(/shake/);
      // The overlay is a sibling of the shaken .app-shell, not a descendant of it, so
      // its `position: fixed` backdrop never inherits the shake transform's containing
      // block.
      expect(shell?.contains(overlay)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("suppresses the shake while the tour is active (GH132-PLAN.md M2, Codex fix 12)", () => {
    vi.useFakeTimers();
    try {
      setWave({ phase: "incoming", index: 0, ticksUntilNext: 1, eventsPerTick: null });
      const { createDriver } = fakeTourDriverFactory();
      const { container } = render(
        <App createPipelineController={() => stubController()} createTourDriver={createDriver} />,
      );
      const shell = container.querySelector(".app-shell");
      expect(shell?.className).not.toMatch(/shake/);

      startTourFromOptions();

      act(() => {
        setWave({ phase: "active", index: 0, ticksUntilNext: null, eventsPerTick: 5 });
      });
      // Without the tour gate, this incoming -> active edge would add .shake, same as
      // the plain test above — the tour's spotlight target would drift out from under
      // driver.js's fixed overlay.
      expect(shell?.className).not.toMatch(/shake/);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("App wave shake gates on run conclusion (GH38 review round 3, F004+F006)", () => {
  function setWaveAndStatus(wave: SimSnapshot["wave"], status: SimSnapshot["status"]): void {
    useGameStore.setState({ snapshot: { ...emptySnapshot(), wave, status } });
  }

  it("never shakes when the incoming -> active edge lands in the same update the run concludes", () => {
    vi.useFakeTimers();
    try {
      setWaveAndStatus(
        { phase: "incoming", index: 0, ticksUntilNext: 1, eventsPerTick: null },
        "running",
      );
      const { container } = render(<App createPipelineController={() => stubController()} />);
      const shell = container.querySelector(".app-shell");
      expect(shell?.className).not.toMatch(/shake/);

      act(() => {
        setWaveAndStatus(
          { phase: "active", index: 0, ticksUntilNext: null, eventsPerTick: 5 },
          "failed",
        );
      });
      expect(shell?.className).not.toMatch(/shake/);

      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(shell?.className).not.toMatch(/shake/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still shakes across the incoming -> active edge while the run keeps running", () => {
    vi.useFakeTimers();
    try {
      setWaveAndStatus(
        { phase: "incoming", index: 0, ticksUntilNext: 1, eventsPerTick: null },
        "running",
      );
      const { container } = render(<App createPipelineController={() => stubController()} />);
      const shell = container.querySelector(".app-shell");

      act(() => {
        setWaveAndStatus(
          { phase: "active", index: 0, ticksUntilNext: null, eventsPerTick: 5 },
          "running",
        );
      });
      expect(shell?.className).toMatch(/shake/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-arms after a suppressed terminal edge: a new run's calm -> incoming -> active(running) still shakes", () => {
    vi.useFakeTimers();
    try {
      // The first run's edge lands as it concludes, so it is suppressed (per the
      // case above).
      setWaveAndStatus(
        { phase: "incoming", index: 0, ticksUntilNext: 1, eventsPerTick: null },
        "running",
      );
      const { container } = render(<App createPipelineController={() => stubController()} />);
      const shell = container.querySelector(".app-shell");
      act(() => {
        setWaveAndStatus(
          { phase: "active", index: 0, ticksUntilNext: null, eventsPerTick: 5 },
          "failed",
        );
      });
      expect(shell?.className).not.toMatch(/shake/);

      // A fresh run starts: calm, then incoming, then active, all while running.
      act(() => {
        setWaveAndStatus(
          { phase: "calm", index: 0, ticksUntilNext: 40, eventsPerTick: null },
          "running",
        );
      });
      act(() => {
        setWaveAndStatus(
          { phase: "incoming", index: 0, ticksUntilNext: 1, eventsPerTick: null },
          "running",
        );
      });
      act(() => {
        setWaveAndStatus(
          { phase: "active", index: 0, ticksUntilNext: null, eventsPerTick: 5 },
          "running",
        );
      });
      expect(shell?.className).toMatch(/shake/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears an in-flight shake immediately when the run concludes mid-animation, without waiting for the timer (GH38 review)", () => {
    vi.useFakeTimers();
    try {
      setWaveAndStatus(
        { phase: "incoming", index: 0, ticksUntilNext: 1, eventsPerTick: null },
        "running",
      );
      const { container } = render(<App createPipelineController={() => stubController()} />);
      const shell = container.querySelector(".app-shell");

      act(() => {
        setWaveAndStatus(
          { phase: "active", index: 0, ticksUntilNext: null, eventsPerTick: 5 },
          "running",
        );
      });
      expect(shell?.className).toMatch(/shake/);

      // The run concludes mid-shake, well before the shake's own timer would clear it.
      act(() => {
        setWaveAndStatus(
          { phase: "active", index: 0, ticksUntilNext: null, eventsPerTick: 5 },
          "failed",
        );
      });
      expect(shell?.className).not.toMatch(/shake/);
    } finally {
      vi.useRealTimers();
    }
  });
});
