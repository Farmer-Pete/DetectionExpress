/**
 * The pipeline controller lifecycle, extracted from `App.tsx` (GH109-PLAN.md): a
 * fresh `RunController` per visible epoch, seeded from the store's transport, and
 * disposed (permanently) on hide or unmount, including React strict-mode's
 * mount/unmount/mount cycle. Render never drives the loop.
 *
 * `controllerRef` is the hook's only return, since three call sites outside the
 * effect need the live controller at call time: `AlgorithmEditor`'s `onRun`, and the
 * dev client's `run` and `onStopLocalMode` (through `useLocalIde`, which takes the
 * ref). Reading `.current` at call time, rather than closing over the controller,
 * keeps those call sites correct across a rebuild without a stale closure.
 */

import type { RefObject } from "react";
import { useEffect, useRef } from "react";
import { localAlgorithmUrl } from "../../game/algorithms-resolve";
import { defaultScenario } from "../../game/registry";
import { createRunController, type RunController } from "../../game/run-controller";
import { getGraph, useGameStore } from "../../game/store";
import { emptySnapshot } from "../../sim/snapshot";
import type { View } from "../view";

/** The real controller factory. Tests inject a stub through `createController`. */
function buildController(): RunController {
  return createRunController({
    scenario: defaultScenario,
    getGraph,
    // The one discriminated input. A local override (set by the dev-only algorithms
    // client) drives url mode; otherwise the in-game editor drives source mode.
    getAlgorithmSource: () => {
      const state = useGameStore.getState();
      if (state.localAlgorithm !== null) {
        const { path, version } = state.localAlgorithm;
        return { kind: "url", path, version, url: localAlgorithmUrl(path, version) };
      }
      return { kind: "source", source: state.source };
    },
    getSeed: () => useGameStore.getState().seed,
    setSnapshot: useGameStore.getState().setSnapshot,
    setError: useGameStore.getState().setError,
    setRunPending: useGameStore.getState().setRunPending,
    bumpRunToken: useGameStore.getState().bumpRunToken,
  });
}

export interface UsePipelineControllerArgs {
  view: View;
  /** Test injection. Defaults to the real buildController. `| undefined` is explicit so a
      caller under exactOptionalPropertyTypes (this repo, tsconfig) can pass an optional
      prop value that may itself be undefined, matching the ModalHost convention. */
  createController?: (() => RunController) | undefined;
}

export function usePipelineController({ view, createController }: UsePipelineControllerArgs): {
  /** The live pipeline controller ref. Null in the metro view. */
  controllerRef: RefObject<RunController | null>;
} {
  const controllerRef = useRef<RunController | null>(null);

  // The pipeline controller lifecycle, conditional on the pipeline view. A fresh
  // controller per visible epoch; the cleanup disposes it (permanently) on hide or
  // unmount, including React strict-mode's mount/unmount/mount cycle.
  useEffect(() => {
    if (view !== "pipeline") {
      return;
    }
    const active = (createController ?? buildController)();
    controllerRef.current = active;
    active.run();
    // Seed the fresh controller from the store's transport. The reflection effects are
    // keyed on [frozen]/[speed], so they do not re-fire on a view change; without this
    // seed a Metro->Pipeline round-trip would run the new engine unfrozen at 1x while
    // the panel still shows frozen/2x.
    active.setFrozen(useGameStore.getState().transport.frozen);
    active.setSpeed(useGameStore.getState().transport.speed);
    return () => {
      active.dispose();
      if (controllerRef.current === active) {
        controllerRef.current = null;
      }
      // The engine is gone. Repaint the empty state now, not left showing this run's
      // rows, so a later Metro-to-Pipeline remount does not flash stale panels during
      // the next controller's load+profile window (F024). This only runs on teardown
      // (a view switch or unmount), never inside run()'s awaits, so a mid-run Apply
      // still leaves the old run's snapshot on screen until the new engine commits.
      useGameStore.getState().setSnapshot(emptySnapshot());
      useGameStore.getState().clearSelection();
    };
  }, [view, createController]);

  // Reflect the store's transport mirror into the pipeline controller. This handles a
  // user toggle from the panel. An engine swap (mount, Apply, hot-reload) is handled by
  // the controller reapplying its retained state on startEngine, which this effect
  // misses because the store value did not change. The two guards together drop no
  // state. `controllerRef` holds the pipeline controller, which is live only in the
  // pipeline view; in the metro view the ref is null and the reflection is a no-op.
  const frozen = useGameStore((s) => s.transport.frozen);
  useEffect(() => {
    controllerRef.current?.setFrozen(frozen);
  }, [frozen]);

  // The same reflection for speed. A panel speed change flows here; an engine swap is
  // handled by the controller reapplying its retained speed on startEngine.
  const speed = useGameStore((s) => s.transport.speed);
  useEffect(() => {
    controllerRef.current?.setSpeed(speed);
  }, [speed]);

  return { controllerRef };
}
