/**
 * `useWorldController` owns the metro-view world controller lifecycle App used to
 * inline: same fresh-per-epoch rule as `usePipelineController`, no return value,
 * since nothing outside the effect touches the world controller.
 */
import { renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { describe, expect, it } from "vitest";
import type { WorldRunController } from "../../game/world-run-controller";
import type { View } from "../view";
import { useWorldController } from "./use-world-controller";

/** A stub world controller whose two methods push into a shared ordered log. */
function loggingWorldController(log: string[]): WorldRunController {
  return {
    run() {
      log.push("run");
    },
    dispose() {
      log.push("dispose");
    },
  };
}

describe("useWorldController", () => {
  it("builds and runs the world controller on the metro view", () => {
    const log: string[] = [];
    const createController = () => loggingWorldController(log);
    renderHook(() => useWorldController({ view: "metro", createController }));
    expect(log).toEqual(["run"]);
  });

  it("builds nothing on the pipeline view", () => {
    let built = 0;
    const createController = () => {
      built += 1;
      return loggingWorldController([]);
    };
    renderHook(() => useWorldController({ view: "pipeline", createController }));
    expect(built).toBe(0);
  });

  it("disposes on unmount", () => {
    const log: string[] = [];
    const createController = () => loggingWorldController(log);
    const { unmount } = renderHook(() => useWorldController({ view: "metro", createController }));
    unmount();
    expect(log).toEqual(["run", "dispose"]);
  });

  it("disposes on a switch back to the pipeline view", () => {
    const log: string[] = [];
    const createController = () => loggingWorldController(log);
    const { rerender } = renderHook(
      ({ view }: { view: View }) => useWorldController({ view, createController }),
      { initialProps: { view: "metro" } },
    );
    rerender({ view: "pipeline" });
    expect(log).toEqual(["run", "dispose"]);
  });

  it("builds a fresh controller per epoch under strict-mode double invoke, matching the pipeline invariant", () => {
    const controllers: Array<{ log: string[] }> = [];
    const createController = () => {
      const log: string[] = [];
      controllers.push({ log });
      return loggingWorldController(log);
    };
    renderHook(() => useWorldController({ view: "metro", createController }), {
      wrapper: StrictMode,
    });
    expect(controllers.length).toBe(2);
    expect(controllers[0]?.log).toEqual(["run", "dispose"]);
    expect(controllers[1]?.log).toEqual(["run"]);
  });
});
