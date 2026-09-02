import { act, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { referenceSource } from "../game/engine-source";
import { defaultEntry } from "../game/registry";
import type { RunController } from "../game/run-controller";
import { useGameStore } from "../game/store";
import { emptySnapshot, type SimSnapshot } from "../sim/snapshot";
import type { WorldLogEvent } from "../sim/world-log";
import { App } from "./App";
import { hireMe, introCopy, liveScenarioFrom } from "./content/narrative";
import { markIntroSeen } from "./onboarding-storage";

const liveScenario = liveScenarioFrom(defaultEntry);

// The zustand store is a singleton shared across test files, so reset the fields
// this file reads before each test. Mirrors the reset pattern in store.test.ts.
//
// The onboarding overlay covers the shell on first load. Shell tests seed the seen
// flag so the overlay stays closed; the onboarding tests clear it to see the overlay.
beforeEach(() => {
  useGameStore.setState({
    source: referenceSource,
    runPending: false,
    transport: { frozen: false, speed: 1 },
    overlayOpen: false,
    selection: null,
    decisionSelection: null,
    mapDialogStack: [],
  });
  markIntroSeen();
});

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
    dispose() {
      disposes += 1;
    },
  };
}

describe("App shell", () => {
  it("renders the heading and the run-status pill", () => {
    const { container } = render(<App createPipelineController={() => stubController()} />);
    // getByRole/getByText throw if missing, so finding them is the assertion.
    const heading = screen.getByRole("heading", { name: "Detection Express" });
    expect(heading.textContent).toBe("Detection Express");
    expect(container.querySelector(".status-pill")?.textContent).toBe("Running");
  });

  it("has no gauge strip on screen at rest: the four gauges live in the Metrics side-panel tab (GH124-PLAN.md Checkpoint 2)", () => {
    render(<App createPipelineController={() => stubController()} />);
    expect(screen.queryByText("Throughput")).toBeNull();
    expect(screen.queryByText("Queue")).toBeNull();
  });

  it("opens the side panel on the metrics tab, gauges included, from the Topbar's Metrics button", () => {
    render(<App createPipelineController={() => stubController()} />);
    fireEvent.click(screen.getByRole("button", { name: "Metrics" }));
    expect(screen.getByRole("dialog", { name: "Side panel" })).toBeDefined();
    expect(screen.getByRole("tab", { name: /metrics/i }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(screen.getByText("Throughput")).toBeDefined();
    expect(screen.getByText("Queue")).toBeDefined();
    expect(screen.getByText("Compute")).toBeDefined();
    expect(screen.getByText("Correctness")).toBeDefined();
  });

  it("has no side panel on screen at rest", () => {
    render(<App createPipelineController={() => stubController()} />);
    expect(screen.queryByRole("dialog", { name: "Side panel" })).toBeNull();
  });

  it("opens the side panel on the chaos tab, chaos ladder default, from the Topbar's Chaos ladder button", () => {
    render(<App createPipelineController={() => stubController()} />);
    fireEvent.click(screen.getByRole("button", { name: "Chaos ladder" }));
    expect(screen.getByRole("dialog", { name: "Side panel" })).toBeDefined();
    expect(screen.getByRole("tab", { name: /chaos/i }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("heading", { name: /chaos ladder/i })).toBeDefined();
    expect(screen.getByText(new RegExp(liveScenario.displayName))).toBeDefined();
  });

  it("opens the side panel on the algorithm tab, with Apply and Reset, from the Topbar's Algorithm button", () => {
    render(<App createPipelineController={() => stubController()} />);
    fireEvent.click(screen.getByRole("button", { name: "Algorithm" }));
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

  it("carries the Hire Me button and the reopen control in the topbar", () => {
    render(<App createPipelineController={() => stubController()} />);
    expect(screen.getByRole("button", { name: hireMe.heading })).toBeDefined();
    expect(screen.getByRole("button", { name: /how this works/i })).toBeDefined();
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
    fireEvent.click(screen.getByRole("button", { name: "Chaos ladder" }));
    const shell = document.querySelector(".app-shell");
    expect(shell?.hasAttribute("inert")).toBe(true);

    fireEvent.keyDown(screen.getByRole("dialog", { name: "Side panel" }), { key: "Escape" });
    expect(shell?.hasAttribute("inert")).toBe(false);
    expect(screen.queryByRole("dialog", { name: "Side panel" })).toBeNull();
  });

  it("publishes overlayOpen true/false as the panel opens and closes, and resets it false on unmount", () => {
    const { unmount } = render(<App createPipelineController={() => stubController()} />);
    expect(useGameStore.getState().overlayOpen).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Chaos ladder" }));
    expect(useGameStore.getState().overlayOpen).toBe(true);

    fireEvent.keyDown(screen.getByRole("dialog", { name: "Side panel" }), { key: "Escape" });
    expect(useGameStore.getState().overlayOpen).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Chaos ladder" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Chaos ladder" }));
    unsubscribe();
    expect(inertAtPublish).toEqual([true]);
  });

  it("opens the panel from the Topbar's Algorithm button on the algorithm tab", () => {
    render(<App createPipelineController={() => stubController()} />);
    fireEvent.click(screen.getByRole("button", { name: "Algorithm" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Chaos ladder" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Chaos ladder" }));
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

  it("is mutually exclusive with the intro overlay: a log-row click while it is open never also opens the event dialog", () => {
    localStorage.clear(); // show the intro overlay on this render (beforeEach marks it seen)
    render(<App createPipelineController={() => stubController()} />);
    act(() => {
      useGameStore.setState({ snapshot: { ...emptySnapshot(), worldEvents: [fareGateEvent(5)] } });
    });
    expect(screen.getByRole("dialog", { name: introCopy.title })).toBeDefined();

    fireEvent.click(screen.getByTestId("log-row-5"));

    expect(useGameStore.getState().mapDialogStack).toEqual([]);
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
    // the same stand-in a real browser click would produce; the map's station
    // control is an SVG `<g>`, which never satisfies `instanceof HTMLElement`
    // (a pre-existing gap in the trigger-restore check, unrelated to the navigation
    // stack), so this test roots the session on a trigger that check does apply to.
    const logRow = screen.getByTestId("log-row-5");
    fireEvent.click(logRow); // opens the event dialog: the root of this session

    fireEvent.click(screen.getByRole("button", { name: "Open place" })); // pushes the place dialog on top
    expect(useGameStore.getState().mapDialogStack).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(useGameStore.getState().mapDialogStack).toEqual([]);
    expect(document.activeElement).toBe(logRow);
  });
});

describe("App onboarding", () => {
  // Record the anchor id each scrollIntoView lands on, so a test asserts the target.
  let scrollTargets: string[];
  const original = Element.prototype.scrollIntoView;

  beforeEach(() => {
    localStorage.clear(); // show the overlay on first load
    scrollTargets = [];
    Element.prototype.scrollIntoView = function scrollIntoView(this: Element) {
      scrollTargets.push(this.id);
    };
  });

  afterEach(() => {
    Element.prototype.scrollIntoView = original;
  });

  it("shows the intro overlay on first load and hides it after dismiss", () => {
    render(<App createPipelineController={() => stubController()} />);
    expect(screen.getByRole("dialog", { name: introCopy.title })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: introCopy.observeLabel }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens the side panel on the chaos tab after Cause chaos closes the intro, without scrolling", () => {
    render(<App createPipelineController={() => stubController()} />);
    fireEvent.click(screen.getByRole("button", { name: introCopy.chaosLabel }));
    expect(screen.queryByRole("dialog", { name: introCopy.title })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Side panel" })).toBeDefined();
    expect(screen.getByRole("tab", { name: /chaos/i }).getAttribute("aria-selected")).toBe("true");
    expect(scrollTargets).toEqual([]);
  });

  it("opens the side panel on the algorithm tab after Edit the Engine closes the intro, without scrolling", () => {
    render(<App createPipelineController={() => stubController()} />);
    fireEvent.click(screen.getByRole("button", { name: introCopy.editLabel }));
    expect(screen.queryByRole("dialog", { name: introCopy.title })).toBeNull();
    expect(screen.getByRole("tab", { name: /algorithm/i }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(scrollTargets).toEqual([]);
  });

  it("restores focus to the Topbar's Chaos ladder button when the panel opened via Cause chaos then closes (the intro's own button is gone)", () => {
    render(<App createPipelineController={() => stubController()} />);
    fireEvent.click(screen.getByRole("button", { name: introCopy.chaosLabel }));
    const panel = screen.getByRole("dialog", { name: "Side panel" });
    const chaosButton = screen.getByRole("button", { name: "Chaos ladder" });

    fireEvent.keyDown(panel, { key: "Escape" });

    expect(screen.queryByRole("dialog", { name: "Side panel" })).toBeNull();
    expect(document.activeElement).toBe(chaosButton);
  });

  it("restores focus to the Topbar's Algorithm button when the panel opened via Edit the Engine then closes", () => {
    render(<App createPipelineController={() => stubController()} />);
    fireEvent.click(screen.getByRole("button", { name: introCopy.editLabel }));
    const panel = screen.getByRole("dialog", { name: "Side panel" });
    const algorithmButton = screen.getByRole("button", { name: "Algorithm" });

    fireEvent.keyDown(panel, { key: "Escape" });

    expect(screen.queryByRole("dialog", { name: "Side panel" })).toBeNull();
    expect(document.activeElement).toBe(algorithmButton);
  });

  it("reopens the overlay from the topbar without clearing the seen flag", () => {
    const { unmount } = render(<App createPipelineController={() => stubController()} />);
    fireEvent.click(screen.getByRole("button", { name: introCopy.observeLabel }));
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /how this works/i }));
    expect(screen.getByRole("dialog", { name: introCopy.title })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: introCopy.observeLabel }));

    // Reopen must not clear the flag. Unmount first so only one App tree is ever
    // mounted, then a fresh mount still treats the intro as seen.
    unmount();
    const { container } = render(<App createPipelineController={() => stubController()} />);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("returns focus to the reopen control after a reopen and dismiss", () => {
    render(<App createPipelineController={() => stubController()} />);
    // The overlay is open on first load. Dismiss it, so the shell is live again.
    fireEvent.click(screen.getByRole("button", { name: introCopy.observeLabel }));
    expect(screen.queryByRole("dialog")).toBeNull();

    // Reopen from the topbar, then dismiss again. Focus returns to the reopen button.
    const reopen = screen.getByRole("button", { name: /how this works/i });
    fireEvent.click(reopen);
    expect(screen.getByRole("dialog", { name: introCopy.title })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: introCopy.observeLabel }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(reopen);
  });

  it("does not restart or dispose the controller when the overlay dismisses", () => {
    const controller = stubController();
    render(<App createPipelineController={() => controller} />);
    expect(controller.runs).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: introCopy.observeLabel }));
    expect(controller.runs).toBe(1);
    expect(controller.disposes).toBe(0);
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

  it("renders the map region and the inspector shell together, map before the inspector (the gauge strip moved into the Metrics side-panel tab)", () => {
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

  it("shakes .app-shell, not the intro overlay's ancestor, so the overlay escapes it (F006)", () => {
    localStorage.clear(); // show the overlay so it is on screen while .app-shell shakes
    vi.useFakeTimers();
    try {
      setWave({ phase: "incoming", index: 0, ticksUntilNext: 1, eventsPerTick: null });
      const { container } = render(<App createPipelineController={() => stubController()} />);
      const shell = container.querySelector(".app-shell");
      const overlay = container.querySelector(".intro-overlay-backdrop");
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
