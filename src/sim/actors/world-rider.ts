/**
 * The live metro rider: an `Actor<WorldReading, WorldEnv>` over the shared trip core,
 * COUPLED to real trains. It picks its destination, line, fare, and balance through the
 * same pure `rider-core` the batch `createRider` uses (single-sourced), but its ride
 * EXECUTION reads the timetable: it waits `at` its origin until the line's train departs
 * (its tap-in), rides `onTrain` until that train arrives at the destination (its
 * tap-out), then dwells at the destination for a short go-home window before going
 * dormant for good. One rider, one trip (GH116): it never plans a second one. The
 * engine evicts it once dormant, and the spawner admits a fresh rider in its place.
 *
 * The coupling reads the timetable's `nextService`, not a live train, so it stays
 * deterministic and the taps stay separable from the trains. `nextService` shares the
 * exact ping-pong/loop stepping with `createTrain`, so a rider boards the real train's
 * departure and alights on its real arrival, never a phantom. `createRider`, the batch
 * actor, keeps its abstract-duration model and its byte-identical readings; only the
 * ride execution differs here. No wall clock, no React (ADR-0007, ARCHITECTURE rule 8).
 */
import {
  GAME_SECONDS_PER_TICK,
  RIDER_GOHOME_DWELL_TICKS,
  TVM_TOPUP_AMOUNT,
} from "../../game/tuning";
import type { Presence } from "../world/presence";
import { nextService, trainIdForLine } from "../world/timetable";
import type { WorldEnv, WorldReading } from "../world-reading";
import type { Actor } from "./actor";
import { createRiderCore, type RiderTripConfig } from "./rider-core";

/**
 * The presence a freshly admitted rider carries before its first act: standing `at`
 * its origin station until it starts its first trip. The engine builds it from the
 * first tick the schedule returns at admission.
 */
export function initialRiderPresence(origin: string, firstTick: number): Presence {
  return { kind: "at", node: origin, fromTick: firstTick, untilTick: firstTick };
}

/**
 * The live rider's ride phase: planning its one trip, waiting to board, riding a
 * train, or (GH116) standing at its destination for the go-home dwell before it goes
 * dormant. `leaving` is terminal: the rider never returns to `planning` from it.
 */
type RidePhase =
  | { kind: "planning"; station: string }
  | {
      kind: "boarding";
      station: string;
      line: string;
      balance: number;
      boardTick: number;
      alightTick: number;
      train: string;
    }
  | { kind: "riding"; alightTick: number }
  | { kind: "leaving" };

/**
 * Build one live rider over a trip config. The returned actor holds its own FSM state;
 * the scheduler owns its rng and next tick. It taps in at its origin's fare gate when
 * its train departs, taps out at the destination's gate when it arrives, and reports a
 * presence the view interpolates (`at` while waiting or dwelling, `onTrain` while riding).
 */
export function createWorldRider(config: RiderTripConfig): Actor<WorldReading, WorldEnv> {
  const core = createRiderCore(config);
  let phase: RidePhase = { kind: "planning", station: config.origin };

  /** The station's TVM id. One machine per station in this sim, so a fixed id. */
  const TVM_MACHINE = "V1";

  /** One TVM `topup` `WorldReading` at `tick`, in the game-second domain. */
  const topup = (station: string, tick: number): WorldReading => ({
    sensor: "tvm",
    reading: {
      ts: tick * GAME_SECONDS_PER_TICK,
      card: config.card,
      station,
      machine: TVM_MACHINE,
      amount: TVM_TOPUP_AMOUNT,
      kind: "topup",
    },
  });

  /** One fare-gate tap `WorldReading` at `tick`, in the game-second domain. */
  const tap = (
    station: string,
    line: string,
    direction: "in" | "out",
    balance: number,
    tick: number,
  ): WorldReading => ({
    sensor: "fare-gate",
    reading: {
      ts: tick * GAME_SECONDS_PER_TICK,
      card: config.card,
      station,
      line,
      direction,
      result: "ok",
      balance,
    },
  });

  return {
    id: config.card,
    start: ({ rng }) => core.startTick(rng),
    act: ({ env, rng, tick }) => {
      if (phase.kind === "boarding") {
        // The train departs now (tick === boardTick): tap in and ride to the arrival.
        const board = phase;
        phase = { kind: "riding", alightTick: board.alightTick };
        return {
          readings: [tap(board.station, board.line, "in", board.balance, tick)],
          nextTick: board.alightTick,
          presence: {
            kind: "onTrain",
            train: board.train,
            fromTick: tick,
            untilTick: board.alightTick,
          },
        };
      }

      if (phase.kind === "riding") {
        // The train has arrived (tick === alightTick): tap out. Still call `core.step`
        // to draw its post-alight dwell sample, so the shared rng draw order is
        // preserved exactly as it is for the batch `createRider`; the sampled dwell
        // itself is unused here (GH116: one trip, then go home, not another dwell
        // before re-planning).
        const transition = core.step(env, rng, tick);
        if (transition.kind !== "exit") {
          // The core must be mid-ride here; a non-exit is unreachable, so end cleanly.
          return { readings: [], nextTick: "dormant" };
        }
        const gohomeUntil = tick + RIDER_GOHOME_DWELL_TICKS;
        phase = { kind: "leaving" };
        return {
          readings: [tap(transition.station, transition.line, "out", transition.balance, tick)],
          nextTick: gohomeUntil,
          presence: {
            kind: "at",
            node: transition.station,
            fromTick: tick,
            untilTick: gohomeUntil,
          },
        };
      }

      if (phase.kind === "leaving") {
        // The go-home dwell has elapsed: the rider's one trip is over. It goes
        // dormant for good, never returning to `planning`. The engine evicts it and
        // the spawner admits a replacement toward `TARGET_RIDERS`.
        return { readings: [], nextTick: "dormant" };
      }

      // PLANNING: decide the next trip through the shared core, then couple to the train.
      const origin = phase.station;
      const transition = core.step(env, rng, tick);
      if (transition.kind !== "enter") {
        // The core is `outside` here, so it returns `enter` or `dormant`; an `exit`
        // is unreachable. A dormant has two causes, told apart WITHOUT drawing rng:
        // the active window has closed (a genuine end), or the balance can no longer
        // afford any trip. On the low-balance path the rider tops up at its origin's
        // TVM and plans again next tick, so it keeps riding instead of dying broke.
        //
        // This is provably additive: the window check draws no rng, and a funded rider
        // only ever reaches dormancy through the window, so it takes the plain
        // `return dormant` below with the exact reading and rng sequence it had before.
        if (tick < config.window.endTick) {
          core.topUp(TVM_TOPUP_AMOUNT);
          return {
            readings: [topup(origin, tick)],
            nextTick: tick + 1,
            presence: { kind: "at", node: origin, fromTick: tick, untilTick: tick + 1 },
          };
        }
        return { readings: [], nextTick: "dormant" };
      }
      const { station, line, dest, balance } = transition;
      const train = trainIdForLine(env.world, line);
      const service = nextService(env.timetable.line(line), station, dest, tick);

      if (service === null) {
        // No timetable service for the pair (unreachable on a shared line, which the
        // core guarantees). Fall back to the core's abstract ride so the rider still
        // completes its trip, moving along the line edge instead of on a train.
        phase = { kind: "riding", alightTick: transition.nextTick };
        return {
          readings: [tap(station, line, "in", balance, tick)],
          nextTick: transition.nextTick,
          presence: {
            kind: "moving",
            from: station,
            to: dest,
            line,
            fromTick: tick,
            untilTick: transition.nextTick,
          },
        };
      }

      if (service.boardTick <= tick) {
        // The train departs on this very tick: board and ride now, no separate wait.
        phase = { kind: "riding", alightTick: service.alightTick };
        return {
          readings: [tap(station, line, "in", balance, tick)],
          nextTick: service.alightTick,
          presence: { kind: "onTrain", train, fromTick: tick, untilTick: service.alightTick },
        };
      }

      // Wait `at` the origin until the train departs; no tap yet.
      phase = {
        kind: "boarding",
        station,
        line,
        balance,
        boardTick: service.boardTick,
        alightTick: service.alightTick,
        train,
      };
      return {
        readings: [],
        nextTick: service.boardTick,
        presence: { kind: "at", node: station, fromTick: tick, untilTick: service.boardTick },
      };
    },
  };
}
