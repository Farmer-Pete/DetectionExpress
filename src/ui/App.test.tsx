import { act, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunController } from "../game/run-controller";
import { useGameStore } from "../game/store";
import type { WorldRunController } from "../game/world-run-controller";
import { referenceSource } from "../sim/scenarios/kiosk-pin-attack/reference";
import { emptySnapshot, type SimSnapshot } from "../sim/snapshot";
import { App } from "./App";
import { hireMe, introCopy, liveScenario } from "./content/narrative";
import { markIntroSeen } from "./onboarding-storage";

// The zustand store is a singleton shared across test files, so reset the fields
// this file reads before each test, or a leaked `sourceLocked` would hide the Apply
// button. Mirrors the reset pattern in store.test.ts.
//
// The onboarding overlay covers the shell on first load. Shell tests seed the seen
// flag so the overlay stays closed; the onboarding tests clear it to see the overlay.
beforeEach(() => {
  useGameStore.setState({
    source: referenceSource,
    sourceLocked: false,
    runPending: false,
    transport: { frozen: false, speed: 1 },
  });
  markIntroSeen();
});

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

/** A no-op world controller, the same shape as the real one. */
function stubWorldController(): WorldRunController & { runs: number; disposes: number } {
  let runs = 0;
  let disposes = 0;
  return {
    get runs() {
      return runs;
    },
    get disposes() {
      return disposes;
    },
    run() {
      runs += 1;
    },
    dispose() {
      disposes += 1;
    },
  };
}

describe("App shell", () => {
  it("renders the heading, both gauges, and the Algorithm editor", () => {
    render(<App createPipelineController={() => stubController()} />);
    // getByRole/getByText throw if missing, so finding them is the assertion.
    const heading = screen.getByRole("heading", { name: "Detection Express" });
    expect(heading.textContent).toBe("Detection Express");
    expect(screen.getByText("Throughput")).toBeDefined();
    expect(screen.getByText("Queue")).toBeDefined();
    expect(screen.getByRole("button", { name: "Apply" })).toBeDefined();
  });

  it("runs the controller on mount and disposes it on unmount", () => {
    const controller = stubController();
    const { unmount } = render(<App createPipelineController={() => controller} />);
    expect(controller.runs).toBe(1);
    unmount();
    expect(controller.disposes).toBe(1);
  });

  it("does not mount the local-IDE control without a dev HMR channel", () => {
    // The local-IDE client gates on a live `import.meta.hot` channel, which the test
    // environment lacks, so neither the "Edit in IDE" nor "Stop editing" control shows.
    render(<App createPipelineController={() => stubController()} />);
    expect(screen.queryByRole("button", { name: "Edit in IDE" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop editing" })).toBeNull();
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

  it("renders the chaos ladder in the shell", () => {
    const { container } = render(<App createPipelineController={() => stubController()} />);
    expect(container.querySelector("#chaos-ladder")).not.toBeNull();
    expect(screen.getByText(new RegExp(liveScenario.displayName))).toBeDefined();
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

  it("scrolls to the chaos ladder, then focuses it, after Cause chaos dismisses", () => {
    render(<App createPipelineController={() => stubController()} />);
    fireEvent.click(screen.getByRole("button", { name: introCopy.chaosLabel }));
    expect(screen.queryByRole("dialog")).toBeNull();
    // The scroll and the focus both land on the chaos ladder after the overlay unmounts.
    expect(scrollTargets).toContain("chaos-ladder");
    expect(document.activeElement?.id).toBe("chaos-ladder");
  });

  it("scrolls to the engine editor, then focuses it, after Edit the Engine dismisses", () => {
    render(<App createPipelineController={() => stubController()} />);
    fireEvent.click(screen.getByRole("button", { name: introCopy.editLabel }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(scrollTargets).toContain("algorithm-editor");
    expect(document.activeElement?.id).toBe("algorithm-editor");
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

describe("App view toggle", () => {
  it("builds the pipeline loop on mount and not the world loop", () => {
    const pipes: ReturnType<typeof stubController>[] = [];
    const worlds: ReturnType<typeof stubWorldController>[] = [];
    render(
      <App
        createPipelineController={() => {
          const stub = stubController();
          pipes.push(stub);
          return stub;
        }}
        createWorldController={() => {
          const stub = stubWorldController();
          worlds.push(stub);
          return stub;
        }}
      />,
    );
    expect(pipes).toHaveLength(1);
    expect(pipes[0]?.runs).toBe(1);
    expect(worlds).toHaveLength(0);
  });

  it("disposes the pipeline loop and builds the world loop on toggle to metro", () => {
    const pipes: ReturnType<typeof stubController>[] = [];
    const worlds: ReturnType<typeof stubWorldController>[] = [];
    render(
      <App
        createPipelineController={() => {
          const stub = stubController();
          pipes.push(stub);
          return stub;
        }}
        createWorldController={() => {
          const stub = stubWorldController();
          worlds.push(stub);
          return stub;
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Metro view" }));
    // The pipeline loop is disposed; a fresh world loop is built and run.
    expect(pipes[0]?.disposes).toBe(1);
    expect(worlds).toHaveLength(1);
    expect(worlds[0]?.runs).toBe(1);
    // The metro chrome is on screen now.
    expect(screen.getByText("LIVING METRO")).toBeDefined();
  });

  it("seeds a freshly built pipeline controller from the store transport after a view round-trip", () => {
    // A Metro round-trip builds a new pipeline controller; the reflection effects keyed
    // on [frozen]/[speed] do not re-fire on a view change, so the effect must seed the
    // fresh controller itself. Otherwise it would run unfrozen at 1x under a frozen/2x panel.
    useGameStore.setState({ transport: { frozen: true, speed: 2 } });
    const pipes: ReturnType<typeof stubController>[] = [];
    render(
      <App
        createPipelineController={() => {
          const stub = stubController();
          pipes.push(stub);
          return stub;
        }}
        createWorldController={() => stubWorldController()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Metro view" }));
    fireEvent.click(screen.getByRole("button", { name: "Pipeline view" }));
    expect(pipes).toHaveLength(2);
    const rebuilt = pipes[1];
    expect(rebuilt).toBeDefined();
    if (!rebuilt) return;
    expect(rebuilt.frozenCalls).toContain(true);
    expect(rebuilt.speedCalls).toContain(2);
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
          createWorldController={() => stubWorldController()}
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

  it("adds .shake to the app root on the incoming -> active edge, then clears it", () => {
    vi.useFakeTimers();
    try {
      setWave({ phase: "incoming", index: 0, ticksUntilNext: 1, eventsPerTick: null });
      const { container } = render(<App createPipelineController={() => stubController()} />);
      const shell = container.querySelector(".app");
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
    const shell = container.querySelector(".app");
    act(() => {
      setWave({ phase: "incoming", index: 0, ticksUntilNext: 5, eventsPerTick: null });
    });
    expect(shell?.className).not.toMatch(/shake/);
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
      const shell = container.querySelector(".app");
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
      const shell = container.querySelector(".app");

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
      const shell = container.querySelector(".app");
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
});
