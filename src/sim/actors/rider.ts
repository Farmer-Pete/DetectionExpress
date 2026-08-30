/**
 * The rider actor: a finite state machine over one fare card (ADR-0007). Scenario
 * assembly gives each card exactly one rider, so one card's tap stream is one
 * coherent journey sequence.
 *
 * ```
 *   Outside --START_TRIP--> Riding --ARRIVE--> Outside
 *     guard: within the active window          guard: reached at the arrival tick
 *            balance >= fare(origin, dest)     action: tap out at dest, emit (out),
 *     action: pick a dest sharing a line,              reschedule after a dwell
 *             tap in at origin, emit (in),
 *             charge the fare, reschedule
 *             after the ride
 * ```
 *
 * Guards make the illegal reachable: a rider cannot exit before entering, its
 * balance never rises, and a rider that cannot afford the next trip goes dormant
 * rather than go negative.
 *
 * The trip logic itself lives in the shared, pure `rider-core` helper, which the
 * live `createWorldRider` also uses. This file is a thin adapter that maps each
 * `RiderTransition` into a `FareGateReading`. The mapping and the draw order are
 * unchanged from GH30, so the emitted reading sequence is byte-identical for every
 * seed and config (the golden regression proves it).
 */
import { GAME_SECONDS_PER_TICK } from "../../game/tuning";
import type { FareGateReading } from "../endpoints/fare-gate/gatekeep";
import type { Actor } from "./actor";
import { createRiderCore, type RiderTripConfig, type RiderTripEnv } from "./rider-core";

/** The read-only environment a rider reads: the world and its distance table. */
type RiderEnv = RiderTripEnv;

/** The rider's configuration, shared with the live world rider's trip core. */
type RiderConfig = RiderTripConfig;

/**
 * Build one rider over a card. The returned actor holds its own FSM state; the
 * scheduler owns its rng and next tick. A thin adapter over the shared trip core:
 * `enter` taps in ("in"), `exit` taps out ("out"), `dormant` stops the rider.
 */
export function createRider(config: RiderConfig): Actor<FareGateReading, RiderEnv> {
  const core = createRiderCore(config);
  return {
    id: config.card,
    start: ({ rng }) => core.startTick(rng),
    act: ({ env, rng, tick }) => {
      const transition = core.step(env, rng, tick);
      if (transition.kind === "dormant") {
        return { readings: [], nextTick: "dormant" };
      }
      const reading: FareGateReading = {
        ts: tick * GAME_SECONDS_PER_TICK,
        card: config.card,
        station: transition.station,
        line: transition.line,
        direction: transition.kind === "enter" ? "in" : "out",
        result: "ok",
        balance: transition.balance,
      };
      return { readings: [reading], nextTick: transition.nextTick };
    },
  };
}
