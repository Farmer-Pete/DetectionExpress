/**
 * The world run controller: the metro's start/stop glue, a sibling to
 * `run-controller.ts`. `App` (from M1) calls a factory for a fresh controller when
 * the metro mode becomes visible and disposes it on hide; disposal is permanent, so
 * a re-shown mode builds a new one. For M0 it is exercised by tests only.
 *
 * It is synchronous: the world loop has no async load or profile, so `run` stops any
 * prior engine, clears the snapshot, and starts a fresh world engine over the
 * current fixtures and seed. Every dependency is injectable, so tests never spawn a
 * real clock.
 */

import { controlReference } from "../sim/entities/control";
import type { DistanceTable } from "../sim/world/distance";
import { buildTimetable } from "../sim/world/timetable";
import type { World } from "../sim/world/world";
import type { WorldEnv } from "../sim/world-reading";
import { emptyWorldSnapshot, type WorldSnapshot } from "../sim/world-snapshot";
import { buildAmbientFixtures, buildAmbientSpawners } from "./ambient-cast";
import {
  startWorld as startWorldDefault,
  type WorldEngineHandle,
  type WorldFixture,
  type WorldStartOptions,
} from "./world-engine";

export interface WorldRunController {
  /** Stop any prior engine and start a fresh one. Safe to call repeatedly. */
  run(): void;
  /** Permanent teardown. A later `run` sees this and does nothing. */
  dispose(): void;
}

export interface WorldRunControllerDeps {
  /** The validated world. The controller derives the timetable and env from it. */
  world: World;
  /** The all-pairs station distances, built once by the caller. */
  distances: DistanceTable;
  /** Extra persistent fixtures beyond the trains the controller builds (none yet in M2). */
  getFixtures: () => readonly WorldFixture[];
  getSeed: () => number;
  setWorldSnapshot: (snapshot: WorldSnapshot) => void;
  /** Defaults to the real world engine; tests inject a fake. */
  start?: (options: WorldStartOptions) => WorldEngineHandle;
  /** Reports a loop failure. */
  onError?: (error: unknown) => void;
  /** Called when a live run tears down on its own. */
  onFinished?: () => void;
  /**
   * The sim speed the engine samples each tick (0 pauses, 1 is real time). The header
   * pause/speed control reads it. Omitted runs at speed 1.
   */
  getSpeed?: () => number;
}

export function createWorldRunController(deps: WorldRunControllerDeps): WorldRunController {
  const startEngine = deps.start ?? startWorldDefault;

  // The timetable and env are immutable, so build them once; the run-controller derives
  // the timetable from the world and puts it in the WorldEnv the engine reads.
  const timetable = buildTimetable(deps.world);
  // The M6 control-room reference the operator and host fixtures read from `env.control`.
  const env: WorldEnv = {
    world: deps.world,
    distances: deps.distances,
    timetable,
    control: controlReference,
  };

  // The persistent ambient fixtures (trains, operators, hosts). Built fresh per run from
  // the shared builder, so a re-run starts every train at its origin rather than mid-ride.
  const buildFixtures = (): readonly WorldFixture[] => buildAmbientFixtures(deps.world, timetable);

  let engine: WorldEngineHandle | null = null;
  let disposed = false;

  const run = (): void => {
    if (disposed) {
      return;
    }
    engine?.stop(); // sync + idempotent
    deps.setWorldSnapshot(emptyWorldSnapshot());
    const runSeed = deps.getSeed();
    // Fresh, seeded spawners per run, so the population replays for a seed.
    const { spawner, staffSpawner, accountSpawner } = buildAmbientSpawners(deps.world, runSeed);
    const startOptions: WorldStartOptions = {
      fixtures: [...buildFixtures(), ...deps.getFixtures()],
      env,
      runSeed,
      setWorldSnapshot: deps.setWorldSnapshot,
      onError: (error) => deps.onError?.(error),
      spawner,
      staffSpawner,
      accountSpawner,
    };
    // Assign the optional speed reader only when given, so exactOptionalPropertyTypes
    // never sees an explicit undefined.
    if (deps.getSpeed !== undefined) {
      startOptions.getSpeed = deps.getSpeed;
    }
    const handle = startEngine(startOptions);
    engine = handle;
    // A disposed completion is ignored; a stale handle sees `engine` moved on.
    void handle.whenStopped.then(() => {
      if (!disposed && engine === handle) {
        deps.onFinished?.();
      }
    });
  };

  const dispose = (): void => {
    disposed = true;
    engine?.stop();
  };

  return { run, dispose };
}
