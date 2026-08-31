/**
 * The world (metro) controller lifecycle, extracted from `App.tsx` (GH109-PLAN.md).
 * Same fresh-per-epoch rule as `usePipelineController`: a mode switch disposes the
 * hidden mode's loop and builds the shown one's, and disposal is permanent, so
 * React strict-mode's mount/unmount/mount cycle is safe. It returns nothing:
 * nothing outside the effect touches the world controller, so no ref leaves the hook.
 */
import { useEffect } from "react";
import { useGameStore } from "../../game/store";
import { createWorldRunController, type WorldRunController } from "../../game/world-run-controller";
import { useWorldStore, worldSpeed } from "../../game/world-store";
import { distanceTable } from "../../sim/world/distance";
import { world } from "../../sim/world/world";
import type { View } from "../view";

/** The station distances are fixed data, built once for the world controller. */
const worldDistances = distanceTable(world);

/** The real controller factory. Tests inject a stub through `createController`. */
function buildWorldController(): WorldRunController {
  return createWorldRunController({
    // The controller derives the timetable and builds the four trains (T1..T4) as
    // persistent fixtures; there are no other fixtures yet (M6 adds operators and hosts).
    world,
    distances: worldDistances,
    getFixtures: () => [],
    getSeed: () => useGameStore.getState().seed,
    setWorldSnapshot: useWorldStore.getState().setWorldSnapshot,
    getSpeed: worldSpeed,
  });
}

export interface UseWorldControllerArgs {
  view: View;
  /** Test injection. Defaults to the real buildWorldController. `| undefined` is explicit
      so a caller under exactOptionalPropertyTypes (this repo, tsconfig) can pass an
      optional prop value that may itself be undefined, matching the ModalHost convention. */
  createController?: (() => WorldRunController) | undefined;
}

export function useWorldController({ view, createController }: UseWorldControllerArgs): void {
  // The world controller lifecycle, conditional on the metro view. Same fresh-per-epoch
  // rule as the pipeline controller; a mode switch disposes the hidden mode's loop and
  // builds the shown one's.
  useEffect(() => {
    if (view !== "metro") {
      return;
    }
    const active = (createController ?? buildWorldController)();
    active.run();
    return () => {
      active.dispose();
    };
  }, [view, createController]);
}
