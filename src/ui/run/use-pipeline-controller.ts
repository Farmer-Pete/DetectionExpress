/**
 * The pipeline controller lifecycle, extracted from `App.tsx` (GH109-PLAN.md): a
 * fresh `RunController` per mounted epoch, seeded from the store's transport, and
 * disposed (permanently) on unmount, including React strict-mode's
 * mount/unmount/mount cycle. Render never drives the loop.
 *
 * `controllerRef` is the hook's only return, since a call site outside the effect
 * needs the live controller at call time: the side panel's Apply, through
 * `useSidePanel`'s `onApply` (GH118-PLAN.md), which takes the ref. Reading `.current`
 * at call time, rather than closing over the controller, keeps that call site
 * correct across a rebuild without a stale closure.
 */

import type { RefObject } from "react";
import { useCallback, useEffect, useRef } from "react";
import { defaultScenario } from "../../game/registry";
import { createRunController, type RunController } from "../../game/run-controller";
import { getGraph, useGameStore } from "../../game/store";
import { buildBlueprint } from "../../sim/scenarios/pin-brute-force/scenario";
import { emptySnapshot } from "../../sim/snapshot";

/** The real controller factory. Tests inject a stub through `createController`. */
function buildController(): RunController {
  return createRunController({
    scenario: defaultScenario,
    // The app's one scenario is pin-brute-force, so its blueprint drives the map cast
    // (GH117 Part B). A later step collapses the pipeline and metro controllers into one.
    buildBlueprint,
    // The app default (GH126-PLAN.md M1): an endless calm baseline, no waves, no
    // checkpoints, no attack. The run controller runs the baseline cast under this
    // mode, ignoring `buildBlueprint` entirely (GH126-PLAN.md M1's "no attacker
    // blueprint"). `buildBlueprint` stays wired below for a later chaos-wave trigger
    // (GH126-PLAN.md M2) to reuse. Reversible per run, not a global flag — a caller
    // that wants the original ramp or the gapless steady stream passes "waves" or
    // "steady" here instead.
    scheduleMode: "endless",
    getGraph,
    // The in-game editor's source string.
    getAlgorithmSource: () => useGameStore.getState().source,
    getSeed: () => useGameStore.getState().seed,
    setSnapshot: useGameStore.getState().setSnapshot,
    setError: useGameStore.getState().setError,
    setRunPending: useGameStore.getState().setRunPending,
    bumpRunToken: useGameStore.getState().bumpRunToken,
  });
}

export interface UsePipelineControllerArgs {
  /** Test injection. Defaults to the real buildController. `| undefined` is explicit so a
      caller under exactOptionalPropertyTypes (this repo, tsconfig) can pass an optional
      prop value that may itself be undefined, matching the ModalHost convention. */
  createController?: (() => RunController) | undefined;
}

export function usePipelineController({ createController }: UsePipelineControllerArgs): {
  /** The live pipeline controller ref. */
  controllerRef: RefObject<RunController | null>;
  /**
   * TEMPORARY (GH126-PLAN.md M2b): fire one chaos wave on the live engine by hand.
   * Reads `controllerRef.current` at call time (a safe no-op with no controller) and
   * delegates to `RunController.triggerWave`, which itself no-ops outside endless mode
   * or during a wave's cooldown. M3 replaces the hand trigger with the real
   * chaos-ladder rung wired through `SidePanel`.
   */
  triggerWave: () => void;
} {
  const controllerRef = useRef<RunController | null>(null);

  // The pipeline controller lifecycle: a fresh controller per mounted epoch; the
  // cleanup disposes it (permanently) on unmount, including React strict-mode's
  // mount/unmount/mount cycle. GH117 unified the metro map onto this same engine, so
  // there is only the one engine now — no view toggle gates this effect.
  useEffect(() => {
    const active = (createController ?? buildController)();
    controllerRef.current = active;
    active.run();
    // Seed the fresh controller from the store's transport. The reflection effects are
    // keyed on [frozen]/[speed], so they do not re-fire on a view change; without this
    // seed a Metro->Pipeline round-trip would run the new engine unfrozen at 1x while
    // the panel still shows frozen/2x.
    active.setFrozen(useGameStore.getState().transport.frozen);
    active.setSpeed(useGameStore.getState().transport.speed);
    // Seed the retained chaos-ladder level too (GH126-PLAN.md M3a), mirroring the
    // transport seed above: the reflection effect below is keyed on [chaosLevel], so it
    // does not re-fire on a view change, and without this seed a fresh engine would run
    // at level 0 while the store still holds the player's selection.
    active.setChaosLevel(useGameStore.getState().chaosLevel);
    return () => {
      active.dispose();
      if (controllerRef.current === active) {
        controllerRef.current = null;
      }
      // The engine is gone. Repaint the empty state now, not left showing this run's
      // rows, so a later remount does not flash stale panels during the next
      // controller's load+profile window (F024). This only runs on teardown (unmount),
      // never inside run()'s awaits, so a mid-run Apply still leaves the old run's
      // snapshot on screen until the new engine commits.
      useGameStore.getState().setSnapshot(emptySnapshot());
      useGameStore.getState().clearSelection();
    };
  }, [createController]);

  // Reflect the store's transport mirror into the pipeline controller. This handles a
  // user toggle from the panel. An engine swap (mount, Apply, hot-reload) is handled by
  // the controller reapplying its retained state on startEngine, which this effect
  // misses because the store value did not change. The two guards together drop no
  // state.
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

  // The same reflection for the chaos-ladder level (GH126-PLAN.md M3a). A ladder
  // selection (M3b's rungs) flows here; an engine swap is handled by the controller
  // reapplying its retained level on startEngine, which this effect misses because the
  // store value did not change. The M3b ladder UI is wired separately; this is only the
  // store -> controller reflection.
  const chaosLevel = useGameStore((s) => s.chaosLevel);
  useEffect(() => {
    controllerRef.current?.setChaosLevel(chaosLevel);
  }, [chaosLevel]);

  // TEMPORARY hand trigger (GH126-PLAN.md M2b). Stable identity so a consumer button
  // needs no per-render callback. M3 wires the ladder rung here instead.
  const triggerWave = useCallback(() => {
    controllerRef.current?.triggerWave();
  }, []);

  return { controllerRef, triggerWave };
}
