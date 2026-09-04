import { act, renderHook, waitFor } from "@testing-library/react";
import { createRef, type RefObject, StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunController } from "../../game/run-controller";
import { useGameStore } from "../../game/store";
import { useSidePanel } from "./use-side-panel";

beforeEach(() => {
  useGameStore.setState({
    transport: { frozen: false, speed: 1 },
    selection: null,
    decisionSelection: null,
    mapDialogStack: [],
    runPending: false,
    error: null,
  });
});

/** The three GH132-PLAN.md M1 Options-tab args every `useSidePanel` call now
 *  needs; the tests below never inspect the Options tab's own rendering (that
 *  lives in `SidePanel.test.tsx`), so a stable default suffices. */
function baseArgs(controllerRef: RefObject<RunController | null>) {
  return {
    controllerRef,
    mapShown: true,
    onToggleMap: vi.fn(),
    onStartTour: vi.fn(),
  };
}

/** A no-op controller: run() never settles, for tests that never touch Apply's edge. */
function stubController(run: () => void = () => {}): RunController {
  return {
    run,
    setFrozen: () => {},
    setSpeed: () => {},
    triggerWave: () => null,
    setChaosLevel: () => {},
    dispose: () => {},
  };
}

/**
 * A controller whose run() flips the store's runPending true, then resolves it false
 * (with the given error) on a later microtask — mirroring the real controller's
 * `await load(source)` gap, so a real intermediate render carries `runPending: true`
 * for the hook's falling-edge watch to observe. Tests drive this with `waitFor`
 * rather than a fixed count of `await Promise.resolve()` ticks: the number of
 * microtask hops between `run()` and the settle is an implementation detail of
 * this stub, not a contract the test should pin.
 */
function asyncRunController(error: { phase: string; message: string } | null): RunController {
  return {
    run: () => {
      useGameStore.getState().setRunPending(true);
      queueMicrotask(() => {
        useGameStore.getState().setError(error);
        useGameStore.getState().setRunPending(false);
      });
    },
    setFrozen: () => {},
    setSpeed: () => {},
    triggerWave: () => null,
    setChaosLevel: () => {},
    dispose: () => {},
  };
}

describe("useSidePanel", () => {
  it("starts closed, on the chaos tab, with no panel node", () => {
    const controllerRef = createRef<RunController | null>();
    const { result } = renderHook(() => useSidePanel(baseArgs(controllerRef)));
    expect(result.current.open).toBe(false);
    expect(result.current.tab).toBe("chaos");
    expect(result.current.sidePanel).toBeNull();
  });

  it("openChaos opens the panel on the chaos tab", () => {
    const controllerRef = createRef<RunController | null>();
    const { result } = renderHook(() => useSidePanel(baseArgs(controllerRef)));
    act(() => result.current.openChaos());
    expect(result.current.open).toBe(true);
    expect(result.current.tab).toBe("chaos");
    expect(result.current.sidePanel).not.toBeNull();
  });

  it("openAlgorithm opens the panel on the algorithm tab", () => {
    const controllerRef = createRef<RunController | null>();
    const { result } = renderHook(() => useSidePanel(baseArgs(controllerRef)));
    act(() => result.current.openAlgorithm());
    expect(result.current.open).toBe(true);
    expect(result.current.tab).toBe("algorithm");
  });

  it("openPanel opens on the chaos tab by default (nothing opened yet)", () => {
    const controllerRef = createRef<RunController | null>();
    const { result } = renderHook(() => useSidePanel(baseArgs(controllerRef)));
    act(() => result.current.openPanel());
    expect(result.current.open).toBe(true);
    expect(result.current.tab).toBe("chaos");
  });

  it("openPanel reopens on whatever tab was last active", () => {
    const controllerRef = createRef<RunController | null>();
    const { result } = renderHook(() => useSidePanel(baseArgs(controllerRef)));
    act(() => result.current.openAlgorithm());
    act(() => result.current.close());
    act(() => result.current.openPanel());
    expect(result.current.open).toBe(true);
    expect(result.current.tab).toBe("algorithm");
  });

  it("openPanel is a no-op while a finding trace is open", () => {
    useGameStore.setState({ selection: { seq: 1 } });
    const controllerRef = createRef<RunController | null>();
    const { result } = renderHook(() => useSidePanel(baseArgs(controllerRef)));
    act(() => result.current.openPanel());
    expect(result.current.open).toBe(false);
  });

  it("close() closes the panel", () => {
    const controllerRef = createRef<RunController | null>();
    const { result } = renderHook(() => useSidePanel(baseArgs(controllerRef)));
    act(() => result.current.openChaos());
    act(() => result.current.close());
    expect(result.current.open).toBe(false);
    expect(result.current.sidePanel).toBeNull();
  });

  it("opening saves the current freeze, then freezes the run", () => {
    const controllerRef = createRef<RunController | null>();
    const { result } = renderHook(() => useSidePanel(baseArgs(controllerRef)));
    expect(useGameStore.getState().transport.frozen).toBe(false);
    act(() => result.current.openChaos());
    expect(useGameStore.getState().transport.frozen).toBe(true);
  });

  it("a dismiss-close restores the freeze saved on open", () => {
    const controllerRef = createRef<RunController | null>();
    const { result } = renderHook(() => useSidePanel(baseArgs(controllerRef)));
    act(() => result.current.openChaos());
    act(() => result.current.close());
    expect(useGameStore.getState().transport.frozen).toBe(false);
  });

  it("a run already frozen before open stays frozen after a dismiss-close", () => {
    useGameStore.getState().setFrozen(true);
    const controllerRef = createRef<RunController | null>();
    const { result } = renderHook(() => useSidePanel(baseArgs(controllerRef)));
    act(() => result.current.openChaos());
    expect(useGameStore.getState().transport.frozen).toBe(true);
    act(() => result.current.close());
    expect(useGameStore.getState().transport.frozen).toBe(true);
  });

  it("openChaos is a no-op while a finding trace is open", () => {
    useGameStore.setState({ selection: { seq: 1 } });
    const controllerRef = createRef<RunController | null>();
    const { result } = renderHook(() => useSidePanel(baseArgs(controllerRef)));
    act(() => result.current.openChaos());
    expect(result.current.open).toBe(false);
    expect(useGameStore.getState().transport.frozen).toBe(false);
  });

  it("openAlgorithm is a no-op while a decision trace is open", () => {
    useGameStore.setState({ decisionSelection: { seq: 1 } });
    const controllerRef = createRef<RunController | null>();
    const { result } = renderHook(() => useSidePanel(baseArgs(controllerRef)));
    act(() => result.current.openAlgorithm());
    expect(result.current.open).toBe(false);
  });

  it("openChaos is a no-op while the place dialog is open (GH124-PLAN.md Checkpoint 4, Codex review gap)", () => {
    useGameStore.setState({
      mapDialogStack: [{ kind: "place", selection: { kind: "node", id: "cen" } }],
    });
    const controllerRef = createRef<RunController | null>();
    const { result } = renderHook(() => useSidePanel(baseArgs(controllerRef)));
    act(() => result.current.openChaos());
    expect(result.current.open).toBe(false);
    expect(useGameStore.getState().transport.frozen).toBe(false);
  });

  it("openAlgorithm is a no-op while the event dialog is open (GH124-PLAN.md Checkpoint 5, Codex review gap)", () => {
    useGameStore.setState({ mapDialogStack: [{ kind: "event", id: 5 }] });
    const controllerRef = createRef<RunController | null>();
    const { result } = renderHook(() => useSidePanel(baseArgs(controllerRef)));
    act(() => result.current.openAlgorithm());
    expect(result.current.open).toBe(false);
  });

  it("openChaos is a no-op while the map/event dialog stack holds more than one entry (a pushed dialog)", () => {
    useGameStore.setState({
      mapDialogStack: [
        { kind: "place", selection: { kind: "train", actorId: "T1" } },
        { kind: "event", id: 5 },
      ],
    });
    const controllerRef = createRef<RunController | null>();
    const { result } = renderHook(() => useSidePanel(baseArgs(controllerRef)));
    act(() => result.current.openChaos());
    expect(result.current.open).toBe(false);
  });

  it("Apply-success closes the panel and unfreezes", async () => {
    const controllerRef = createRef<RunController | null>();
    controllerRef.current = asyncRunController(null);
    const { result } = renderHook(() => useSidePanel(baseArgs(controllerRef)));
    act(() => result.current.openAlgorithm());
    expect(useGameStore.getState().transport.frozen).toBe(true);
    act(() => result.current.onApply());
    await waitFor(() => expect(result.current.open).toBe(false));
    expect(useGameStore.getState().transport.frozen).toBe(false);
  });

  it("Apply-failure keeps the panel open and frozen, clearing the intent", async () => {
    const controllerRef = createRef<RunController | null>();
    controllerRef.current = asyncRunController({ phase: "load", message: "boom" });
    const { result } = renderHook(() => useSidePanel(baseArgs(controllerRef)));
    act(() => result.current.openAlgorithm());
    act(() => result.current.onApply());
    await waitFor(() =>
      expect(useGameStore.getState().error).toEqual({ phase: "load", message: "boom" }),
    );
    expect(result.current.open).toBe(true);
    expect(useGameStore.getState().transport.frozen).toBe(true);
  });

  it("onApply does nothing when the controllerRef is null", () => {
    const controllerRef = createRef<RunController | null>();
    const { result } = renderHook(() => useSidePanel(baseArgs(controllerRef)));
    act(() => result.current.openAlgorithm());
    expect(() => act(() => result.current.onApply())).not.toThrow();
    expect(result.current.open).toBe(true);
  });

  it("mounts safely under React Strict Mode", () => {
    const controllerRef = createRef<RunController | null>();
    const { result } = renderHook(() => useSidePanel(baseArgs(controllerRef)), {
      wrapper: StrictMode,
    });
    expect(result.current.open).toBe(false);
    act(() => result.current.openChaos());
    expect(result.current.open).toBe(true);
    expect(useGameStore.getState().transport.frozen).toBe(true);
  });

  it("unmounting while open releases the freeze it holds", () => {
    const controllerRef = createRef<RunController | null>();
    const { result, unmount } = renderHook(() => useSidePanel(baseArgs(controllerRef)));
    act(() => result.current.openChaos());
    expect(useGameStore.getState().transport.frozen).toBe(true);
    unmount();
    expect(useGameStore.getState().transport.frozen).toBe(false);
  });

  it("unmounting while open under Strict Mode still releases the freeze exactly once", () => {
    const controllerRef = createRef<RunController | null>();
    const { result, unmount } = renderHook(() => useSidePanel(baseArgs(controllerRef)), {
      wrapper: StrictMode,
    });
    act(() => result.current.openChaos());
    expect(useGameStore.getState().transport.frozen).toBe(true);
    unmount();
    expect(useGameStore.getState().transport.frozen).toBe(false);
  });

  it("run() is invoked when Apply is triggered through a live controller", () => {
    const run = vi.fn();
    const controllerRef = createRef<RunController | null>();
    controllerRef.current = stubController(run);
    const { result } = renderHook(() => useSidePanel(baseArgs(controllerRef)));
    act(() => result.current.openAlgorithm());
    act(() => result.current.onApply());
    expect(run).toHaveBeenCalledTimes(1);
  });
});
