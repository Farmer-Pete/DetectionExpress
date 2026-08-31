/**
 * `usePipelineController` owns the pipeline-view lifecycle effect App used to
 * inline: a fresh controller per visible epoch, seeded from the store transport,
 * disposed (with an empty-snapshot repaint and a cleared selection) on hide or
 * unmount, plus the two transport-reflector effects. These tests exercise the hook
 * directly with `renderHook`, mirroring `wave/use-wave-phase-edge.test.ts`'s pattern,
 * and inject a logging stub controller so build/teardown order is observable.
 */
import { act, renderHook } from "@testing-library/react";
import type { RefObject } from "react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunController } from "../../game/run-controller";
import { useGameStore } from "../../game/store";
import { emptySnapshot } from "../../sim/snapshot";
import type { View } from "../view";
import { usePipelineController } from "./use-pipeline-controller";

/** A stub controller whose four methods push into a shared ordered log. */
function loggingController(log: string[]): RunController {
  return {
    run() {
      log.push("run");
    },
    setFrozen(frozen) {
      log.push(`setFrozen:${frozen}`);
    },
    setSpeed(speed) {
      log.push(`setSpeed:${speed}`);
    },
    dispose() {
      log.push("dispose");
    },
  };
}

beforeEach(() => {
  useGameStore.setState({ transport: { frozen: false, speed: 1 } });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("usePipelineController", () => {
  it("builds a fresh controller and runs it on the pipeline view, seeded from the store transport", () => {
    useGameStore.setState({ transport: { frozen: true, speed: 2 } });
    const log: string[] = [];
    const createController = () => loggingController(log);
    const { result } = renderHook(() =>
      usePipelineController({ view: "pipeline", createController }),
    );

    // The ref is live and the build order is exactly run(), then the transport seed:
    // setFrozen, then setSpeed. The two transport-reflector effects also run once on
    // mount (their dependency arrays always fire on the first render), reapplying the
    // same seeded values right after — that duplication is the pre-extraction
    // behavior, not something this hook introduces.
    expect(result.current.controllerRef.current).not.toBeNull();
    expect(log).toEqual(["run", "setFrozen:true", "setSpeed:2", "setFrozen:true", "setSpeed:2"]);
  });

  it("disposes on unmount", () => {
    const log: string[] = [];
    const createController = () => loggingController(log);
    const { unmount } = renderHook(() =>
      usePipelineController({ view: "pipeline", createController }),
    );
    unmount();
    expect(log).toContain("dispose");
  });

  it("builds nothing on the metro view and leaves controllerRef.current null", () => {
    let built = 0;
    const createController = () => {
      built += 1;
      return loggingController([]);
    };
    const { result } = renderHook(() => usePipelineController({ view: "metro", createController }));
    expect(built).toBe(0);
    expect(result.current.controllerRef.current).toBeNull();
  });

  it("reflects later store frozen/speed changes into the controller", () => {
    const log: string[] = [];
    const createController = () => loggingController(log);
    renderHook(() => usePipelineController({ view: "pipeline", createController }));
    log.length = 0; // drop the mount-time seed calls (and their reflector echo); only
    // later reflections matter here

    act(() => {
      useGameStore.setState({ transport: { frozen: true, speed: 1 } });
    });
    act(() => {
      useGameStore.setState({ transport: { frozen: true, speed: 2 } });
    });
    expect(log).toEqual(["setFrozen:true", "setSpeed:2"]);
  });

  it("builds a fresh controller per epoch under strict-mode double invoke", () => {
    const controllers: Array<{ log: string[] }> = [];
    const createController = () => {
      const log: string[] = [];
      controllers.push({ log });
      return loggingController(log);
    };
    renderHook(() => usePipelineController({ view: "pipeline", createController }), {
      wrapper: StrictMode,
    });
    // Strict mode mounts, unmounts (disposing the first), then remounts a fresh one.
    expect(controllers.length).toBe(2);
    expect(controllers[0]?.log).toContain("dispose");
    expect(controllers[1]?.log).toContain("run");
    expect(controllers[1]?.log).not.toContain("dispose");
  });

  it("on teardown, disposes, clears the ref, then repaints the empty snapshot and clears the selection, in order", () => {
    const log: string[] = [];
    const createController = () => loggingController(log);
    // Probe the ref's value at the instant setSnapshot runs, to prove the ref was
    // already cleared BEFORE the repaint (dispose -> ref-clear -> setSnapshot), not
    // merely that both happened by the end. `controllerRefHandle` is assigned after
    // renderHook returns; the mock reads it lazily, at unmount.
    let controllerRefHandle: RefObject<RunController | null> | null = null;
    let refAtSetSnapshot: RunController | null | "unread" = "unread";
    const setSnapshotSpy = vi
      .spyOn(useGameStore.getState(), "setSnapshot")
      .mockImplementation((snapshot) => {
        refAtSetSnapshot = controllerRefHandle?.current ?? null;
        log.push("setSnapshot");
        useGameStore.setState({ snapshot });
      });
    const clearSelectionSpy = vi
      .spyOn(useGameStore.getState(), "clearSelection")
      .mockImplementation(() => {
        log.push("clearSelection");
      });

    const { result, unmount } = renderHook(() =>
      usePipelineController({ view: "pipeline", createController }),
    );
    const controllerRef = result.current.controllerRef;
    controllerRefHandle = controllerRef;
    log.length = 0; // drop mount-time calls; only the teardown order matters here
    unmount();

    expect(log).toEqual(["dispose", "setSnapshot", "clearSelection"]);
    expect(controllerRef.current).toBeNull();
    expect(refAtSetSnapshot).toBeNull(); // the ref was already cleared when the repaint ran
    expect(setSnapshotSpy).toHaveBeenCalledWith(emptySnapshot());
    expect(clearSelectionSpy).toHaveBeenCalledTimes(1);
  });

  it("leaves a newer controller in the ref on teardown (the identity guard)", () => {
    // The teardown clears the ref only when it still holds THIS epoch's controller
    // (`if (controllerRef.current === active)`). An Apply or hot-reload can swap a newer
    // controller into the ref before this epoch tears down; the guard must not null that
    // newer one. Simulate the swap, then unmount, and assert the newer controller stays.
    const log: string[] = [];
    const createController = () => loggingController(log);
    const { result, unmount } = renderHook(() =>
      usePipelineController({ view: "pipeline", createController }),
    );
    const controllerRef = result.current.controllerRef;
    const newer = loggingController([]);
    controllerRef.current = newer;
    unmount();
    expect(controllerRef.current).toBe(newer);
  });

  it("uses the real buildController default when no factory is injected (module wiring only, no run)", () => {
    // No factory injected and view is metro, so the default `buildController` is never
    // invoked; this only proves the hook does not require the prop.
    const { result } = renderHook(({ view }: { view: View }) => usePipelineController({ view }), {
      initialProps: { view: "metro" },
    });
    expect(result.current.controllerRef.current).toBeNull();
  });
});
