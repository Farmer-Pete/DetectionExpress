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
 */
import { GAME_SECONDS_PER_TICK } from "../../game/tuning";
import type { FareGateReading } from "../endpoints/fare-gate/gatekeep";
import { type DistanceTable, distanceMinutes, sharedLineRoute } from "../world/distance";
import type { World } from "../world/world";
import { type Actor, minutesToTicks } from "./actor";

/** The read-only environment a rider reads: the world and its distance table. */
interface RiderEnv {
  world: World;
  distances: DistanceTable;
}

/** An inclusive, non-negative integer tick range a duration is sampled from. */
interface TickRange {
  min: number;
  max: number;
}

/** The fare law: `fare = base + perMinute * distanceMinutes(origin, dest)`. */
interface FareModel {
  base: number;
  perMinute: number;
}

interface RiderConfig {
  /** The card this rider carries. Becomes the actor id. */
  card: string;
  /** The station the rider starts at. */
  origin: string;
  /** Starting balance, a non-negative integer in whole currency units. */
  balance: number;
  /** The active window `[startTick, endTick)` the rider starts trips within. */
  window: { startTick: number; endTick: number };
  fare: FareModel;
  /** Extra ride ticks beyond the travel time, so a ride is at least the distance. */
  jitterTicks: TickRange;
  /** Idle ticks between trips. */
  dwellTicks: TickRange;
}

/** The rider's own FSM state. */
type RiderState =
  | { kind: "outside"; station: string }
  | { kind: "riding"; dest: string; line: string };

/** Reject a range that is not a non-negative integer span, so every scheduled tick stays whole. */
function assertTickRange(range: TickRange, label: string): void {
  if (
    !Number.isInteger(range.min) ||
    !Number.isInteger(range.max) ||
    range.min < 0 ||
    range.max < range.min
  ) {
    throw new Error(`rider: ${label} must be a non-negative integer range with min <= max.`);
  }
}

/**
 * Reject a fare or balance value that is not a whole, non-negative amount. Both the
 * balance and the fare coefficients must be non-negative integers, so the computed
 * fare and the running balance stay non-negative integers in whole currency units.
 */
function assertWholeAmount(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`rider: ${label} must be a non-negative integer.`);
  }
}

/** Sample a whole number of ticks in `[min, max]` from the seeded rng. */
function sampleTicks(range: TickRange, rng: () => number): number {
  return range.min + Math.floor(rng() * (range.max - range.min + 1));
}

/** The whole-unit fare for a ride, from the distance table. */
function fareFor(env: RiderEnv, from: string, to: string, fare: FareModel): number {
  return fare.base + fare.perMinute * distanceMinutes(env.distances, from, to);
}

/**
 * Pick a destination that shares a line with the origin and that the rider can
 * afford, drawn from the seeded rng. Returns null when none is affordable, which
 * sends the rider dormant.
 */
function pickDestination(
  env: RiderEnv,
  from: string,
  balance: number,
  fare: FareModel,
  rng: () => number,
): string | null {
  const candidates: string[] = [];
  for (const station of env.world.stations) {
    if (station.id === from) {
      continue;
    }
    if (sharedLineRoute(env.world, from, station.id) === null) {
      continue;
    }
    if (balance < fareFor(env, from, station.id, fare)) {
      continue;
    }
    candidates.push(station.id);
  }
  const chosen = candidates[Math.floor(rng() * candidates.length)];
  return chosen ?? null;
}

/**
 * Build one rider over a card. The returned actor holds its own FSM state; the
 * scheduler owns its rng and next tick.
 */
export function createRider(config: RiderConfig): Actor<FareGateReading, RiderEnv> {
  assertTickRange(config.jitterTicks, "jitterTicks");
  assertTickRange(config.dwellTicks, "dwellTicks");
  assertWholeAmount(config.balance, "balance");
  assertWholeAmount(config.fare.base, "fare.base");
  assertWholeAmount(config.fare.perMinute, "fare.perMinute");

  let balance = config.balance;
  let state: RiderState = { kind: "outside", station: config.origin };

  return {
    id: config.card,
    start: ({ rng }) => config.window.startTick + sampleTicks(config.dwellTicks, rng),
    act: ({ env, rng, tick }) => {
      if (state.kind === "riding") {
        // ARRIVE: tap out at the destination. Exit does not charge, so the balance
        // is unchanged. Then idle for a dwell before the next trip.
        const reading: FareGateReading = {
          ts: tick * GAME_SECONDS_PER_TICK,
          card: config.card,
          station: state.dest,
          line: state.line,
          direction: "out",
          result: "ok",
          balance,
        };
        state = { kind: "outside", station: state.dest };
        // Floor the dwell at one tick so a sampled zero still strictly advances the
        // scheduler, which rejects a reschedule that does not move past `tick`.
        return {
          readings: [reading],
          nextTick: tick + Math.max(1, sampleTicks(config.dwellTicks, rng)),
        };
      }

      // OUTSIDE: try to start a trip, if still within the window and able to afford one.
      if (tick >= config.window.endTick) {
        return { readings: [], nextTick: "dormant" };
      }
      const origin = state.station;
      const dest = pickDestination(env, origin, balance, config.fare, rng);
      if (dest === null) {
        return { readings: [], nextTick: "dormant" };
      }
      const route = sharedLineRoute(env.world, origin, dest);
      if (route === null) {
        return { readings: [], nextTick: "dormant" };
      }

      // START_TRIP: tap in at the origin, charge the fare, then ride at least the
      // travel time. The emitted balance is the balance after the charge.
      balance -= fareFor(env, origin, dest, config.fare);
      const reading: FareGateReading = {
        ts: tick * GAME_SECONDS_PER_TICK,
        card: config.card,
        station: origin,
        line: route.line,
        direction: "in",
        result: "ok",
        balance,
      };
      const rideTicks = minutesToTicks(route.minutes) + sampleTicks(config.jitterTicks, rng);
      state = { kind: "riding", dest, line: route.line };
      return { readings: [reading], nextTick: tick + rideTicks };
    },
  };
}
