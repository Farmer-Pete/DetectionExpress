/**
 * The live metro rider: an `Actor<WorldReading, WorldEnv>` over the shared trip core,
 * COUPLED to real trains. It picks its destination, line, fare, and balance through the
 * same pure `rider-core` the batch `createRider` uses (single-sourced), but its ride
 * EXECUTION reads the timetable: it waits `at` its origin until the line's train departs
 * (its tap-in), rides `onTrain` until that train arrives at the destination (its
 * tap-out), then dwells at the destination before planning the next trip.
 *
 * The coupling reads the timetable's `nextService`, not a live train, so it stays
 * deterministic and the taps stay separable from the trains. `nextService` shares the
 * exact ping-pong/loop stepping with `createTrain`, so a rider boards the real train's
 * departure and alights on its real arrival, never a phantom. `createRider`, the batch
 * actor, keeps its abstract-duration model and its byte-identical readings; only the
 * ride execution differs here. No wall clock, no React (ADR-0007, ARCHITECTURE rule 8).
 */
import { GAME_SECONDS_PER_TICK } from "../../game/tuning";
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

/** The live rider's ride phase: planning a trip, waiting to board, or riding a train. */
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
  | { kind: "riding"; alightTick: number };

/**
 * Build one live rider over a trip config. The returned actor holds its own FSM state;
 * the scheduler owns its rng and next tick. It taps in at its origin's fare gate when
 * its train departs, taps out at the destination's gate when it arrives, and reports a
 * presence the view interpolates (`at` while waiting or dwelling, `onTrain` while riding).
 */
export function createWorldRider(config: RiderTripConfig): Actor<WorldReading, WorldEnv> {
  const core = createRiderCore(config);
  let phase: RidePhase = { kind: "planning", station: config.origin };

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
        // The train has arrived (tick === alightTick): tap out, then let the core draw
        // the post-alight dwell and hand back the destination it is now `at`.
        const transition = core.step(env, rng, tick);
        if (transition.kind !== "exit") {
          // The core must be mid-ride here; a non-exit is unreachable, so end cleanly.
          return { readings: [], nextTick: "dormant" };
        }
        phase = { kind: "planning", station: transition.station };
        return {
          readings: [tap(transition.station, transition.line, "out", transition.balance, tick)],
          nextTick: transition.nextTick,
          presence: {
            kind: "at",
            node: transition.station,
            fromTick: tick,
            untilTick: transition.nextTick,
          },
        };
      }

      // PLANNING: decide the next trip through the shared core, then couple to the train.
      const transition = core.step(env, rng, tick);
      if (transition.kind !== "enter") {
        // The core is `outside` here, so it returns `enter` or `dormant`; an `exit`
        // is unreachable. Either way, no trip starts this tick.
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
