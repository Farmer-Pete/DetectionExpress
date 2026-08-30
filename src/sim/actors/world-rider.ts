/**
 * The live metro rider: an `Actor<WorldReading, WorldEnv>` over the shared trip core.
 * It is the benign cast's first member. On a trip it taps in at the origin and taps
 * out at the destination, emitting fare-gate `WorldReading`s from its own FSM
 * transitions (the M1 tap trigger: no trains yet, so a tap is not coupled to a train
 * arrival). It reports a `presence` the view interpolates: `moving` along the line
 * from origin to destination during the ride, `at` the station while it dwells.
 *
 * The trip logic is the same pure `rider-core` the batch `createRider` uses, so a
 * funded rider's fare-gate readings are byte-identical to `createRider` for a seed.
 * Native to the live schedule: there is no adapter over the batch actor.
 */
import { GAME_SECONDS_PER_TICK } from "../../game/tuning";
import type { Presence } from "../world/presence";
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
 * Build one live rider over a trip config. The returned actor holds its own FSM
 * state; the scheduler owns its rng and next tick. Each transition emits one
 * fare-gate `WorldReading` and a matching presence.
 */
export function createWorldRider(config: RiderTripConfig): Actor<WorldReading, WorldEnv> {
  const core = createRiderCore(config);
  return {
    id: config.card,
    start: ({ rng }) => core.startTick(rng),
    act: ({ env, rng, tick }) => {
      const transition = core.step(env, rng, tick);
      if (transition.kind === "dormant") {
        return { readings: [], nextTick: "dormant" };
      }
      const reading: WorldReading = {
        sensor: "fare-gate",
        reading: {
          ts: tick * GAME_SECONDS_PER_TICK,
          card: config.card,
          station: transition.station,
          line: transition.line,
          direction: transition.kind === "enter" ? "in" : "out",
          result: "ok",
          balance: transition.balance,
        },
      };
      const presence: Presence =
        transition.kind === "enter"
          ? {
              kind: "moving",
              from: transition.station,
              to: transition.dest,
              line: transition.line,
              fromTick: tick,
              untilTick: transition.nextTick,
            }
          : {
              kind: "at",
              node: transition.station,
              fromTick: tick,
              untilTick: transition.nextTick,
            };
      return { readings: [reading], nextTick: transition.nextTick, presence };
    },
  };
}
