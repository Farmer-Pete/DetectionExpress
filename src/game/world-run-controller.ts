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

import { createAccountRiderSpawner } from "../sim/actors/account-rider-spawner";
import { createHost, initialHostPresence } from "../sim/actors/host";
import { createOperator, initialOperatorPresence } from "../sim/actors/operator";
import { createRiderSpawner } from "../sim/actors/rider-spawner";
import { createStaffSpawner } from "../sim/actors/staff-spawner";
import { createTrain, initialTrainPresence } from "../sim/actors/train";
import { controlReference } from "../sim/entities/control";
import type { DistanceTable } from "../sim/world/distance";
import { buildTimetable, trainIdForLine } from "../sim/world/timetable";
import type { World } from "../sim/world/world";
import type { WorldEnv } from "../sim/world-reading";
import { emptyWorldSnapshot, type WorldSnapshot } from "../sim/world-snapshot";
import {
  ACCOUNT_RIDER_TARGET,
  CONTROL_LAUNCH_PHASE_TICKS,
  HOST_RELAY_TICKS,
  OPERATOR_COMMAND_TICKS,
  STAFF_TARGET,
  TARGET_RIDERS,
} from "./tuning";
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

  // One persistent train per line, ids T1..T4 in world-line order. Fresh per run so a
  // re-run starts every train at its origin rather than mid-ride (they hold ride state).
  const buildTrains = (): readonly WorldFixture[] =>
    deps.world.lines.map((line): WorldFixture => {
      const schedule = timetable.line(line.id);
      const origin = schedule.stops[0] ?? line.id;
      // The same deterministic line -> train id the live rider names when it boards,
      // so a rider's onTrain presence references this exact train fixture.
      const id = trainIdForLine(deps.world, line.id);
      return {
        actor: createTrain({ id, line: line.id, startTick: schedule.startTick }),
        kind: "train",
        initialPresence: (firstTick) => initialTrainPresence(origin, firstTick, line.id),
      };
    });

  // One persistent operator per authorized OCC console, seated at the control center for
  // the whole run (never spawned, never evicted). Staggered launch phases keep them from
  // issuing commands in lockstep.
  const occId = deps.world.controlCenter.id;
  const buildOperators = (): readonly WorldFixture[] =>
    controlReference.consoles.map((console, index): WorldFixture => {
      const id = `OP${index + 1}`;
      return {
        actor: createOperator({
          id,
          node: occId,
          console,
          startTick: index * CONTROL_LAUNCH_PHASE_TICKS,
          cadenceTicks: OPERATOR_COMMAND_TICKS,
        }),
        kind: "operator",
        initialPresence: (firstTick) => initialOperatorPresence(occId, firstTick),
      };
    });

  // One persistent host per site network host, sitting at its site for the whole run.
  const buildHosts = (): readonly WorldFixture[] =>
    controlReference.hosts.map((siteHost, index): WorldFixture => {
      const id = `H${index + 1}`;
      return {
        actor: createHost({
          id,
          site: siteHost.site,
          host: siteHost.host,
          startTick: index * CONTROL_LAUNCH_PHASE_TICKS,
          cadenceTicks: HOST_RELAY_TICKS,
        }),
        kind: "host",
        initialPresence: (firstTick) => initialHostPresence(siteHost.site, firstTick),
      };
    });

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
    const spawner = createRiderSpawner({
      seed: runSeed,
      world: deps.world,
      target: TARGET_RIDERS,
    });
    const staffSpawner = createStaffSpawner({
      seed: runSeed,
      world: deps.world,
      target: STAFF_TARGET,
    });
    const accountSpawner = createAccountRiderSpawner({
      seed: runSeed,
      world: deps.world,
      target: ACCOUNT_RIDER_TARGET,
    });
    const startOptions: WorldStartOptions = {
      fixtures: [...buildTrains(), ...buildOperators(), ...buildHosts(), ...deps.getFixtures()],
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
