/**
 * The pure trip-planning core shared by `createRider` (the batch fare-gate actor
 * from GH30) and `createWorldRider` (the live metro actor). It holds one rider's FSM
 * state and balance and decides each transition, drawing from the seeded rng in a
 * fixed order. Neither caller duplicates the trip logic; each maps a `RiderTransition`
 * into its own reading shape (and, for the live actor, a presence).
 *
 * The draw order is the contract: `startTick` draws one dwell sample; a START
 * transition draws the destination then the ride jitter; an ARRIVE transition draws
 * one dwell sample. `createRider` kept this exact order, so its emitted readings stay
 * byte-identical for every seed and config (the GH30 golden regression proves it).
 * Pure, no RNG of its own, no React (ADR-0007, ARCHITECTURE rule 8).
 */
import { type DistanceTable, distanceMinutes, sharedLineRoute } from "../world/distance";
import type { World } from "../world/world";
import { minutesToTicks } from "./actor";

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

/** The read-only environment a rider's trip core reads: the world and its distances. */
export interface RiderTripEnv {
  world: World;
  distances: DistanceTable;
}

/** One rider's whole trip configuration, shared by both the batch and live actors. */
export interface RiderTripConfig {
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

/**
 * The result of one transition. `enter` taps in at the origin and starts riding to
 * `dest`; `exit` taps out at the destination and starts dwelling; `dormant` ends the
 * rider. `station` and `line` are the tap's location and route; `nextTick` is the
 * arrival tick (enter) or the next planning tick (exit). Both callers read this.
 */
type RiderTransition =
  | {
      kind: "enter";
      station: string;
      line: string;
      balance: number;
      dest: string;
      nextTick: number;
    }
  | { kind: "exit"; station: string; line: string; balance: number; nextTick: number }
  | { kind: "dormant" };

/** The stateful trip core: its first tick, then one transition per `step`. */
export interface RiderCore {
  /** The first tick, `startTick + a dwell sample`. Draws one rng value. */
  startTick(rng: () => number): number;
  /** One FSM transition at `tick`, advancing the held state and balance. */
  step(env: RiderTripEnv, rng: () => number, tick: number): RiderTransition;
  /**
   * Add whole currency units to the running balance, a TVM top-up. It draws no rng
   * and changes no FSM state, so a caller that never tops up (the batch `createRider`)
   * keeps its byte-identical reading sequence; only the live `createWorldRider` calls
   * it, on the low-balance path where it would otherwise go dormant.
   */
  topUp(amount: number): void;
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
 * Reject a window whose bounds are not non-negative integers or whose start is past
 * its end, so `tick >= endTick` is a reachable, well-ordered stop condition rather
 * than a comparison a NaN or reversed bound can defeat.
 */
function assertTickWindow(window: { startTick: number; endTick: number }): void {
  if (
    !Number.isInteger(window.startTick) ||
    !Number.isInteger(window.endTick) ||
    window.startTick < 0 ||
    window.endTick < 0 ||
    window.startTick > window.endTick
  ) {
    throw new Error(
      "rider: window must have non-negative integer startTick and endTick with startTick <= endTick.",
    );
  }
}

/**
 * Reject a fare or balance value that is not a whole, non-negative amount, so the
 * computed fare and the running balance stay non-negative integers in whole currency
 * units.
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
function fareFor(env: RiderTripEnv, from: string, to: string, fare: FareModel): number {
  return fare.base + fare.perMinute * distanceMinutes(env.distances, from, to);
}

/**
 * Pick a destination that shares a line with the origin and that the rider can
 * afford, drawn from the seeded rng. Returns null when none is affordable, which
 * sends the rider dormant. Draws exactly one rng value.
 */
function pickDestination(
  env: RiderTripEnv,
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
 * Build one rider's trip core over a config. It validates the config on construction
 * (so both actors reject a bad config at build time) and holds the FSM state and
 * balance. The scheduler owns the rng and next tick; this owns only the trip logic.
 */
export function createRiderCore(config: RiderTripConfig): RiderCore {
  assertTickRange(config.jitterTicks, "jitterTicks");
  assertTickRange(config.dwellTicks, "dwellTicks");
  assertTickWindow(config.window);
  assertWholeAmount(config.balance, "balance");
  assertWholeAmount(config.fare.base, "fare.base");
  assertWholeAmount(config.fare.perMinute, "fare.perMinute");

  let balance = config.balance;
  let state: RiderState = { kind: "outside", station: config.origin };

  return {
    startTick: (rng) => config.window.startTick + sampleTicks(config.dwellTicks, rng),
    topUp: (amount) => {
      assertWholeAmount(amount, "topUp amount");
      balance += amount;
    },
    step: (env, rng, tick) => {
      if (state.kind === "riding") {
        // ARRIVE: tap out at the destination. Exit does not charge, so the balance
        // is unchanged. Floor the dwell at one tick so a sampled zero still strictly
        // advances the scheduler, which rejects a reschedule that does not move past
        // `tick`.
        const dest = state.dest;
        const line = state.line;
        state = { kind: "outside", station: dest };
        return {
          kind: "exit",
          station: dest,
          line,
          balance,
          nextTick: tick + Math.max(1, sampleTicks(config.dwellTicks, rng)),
        };
      }

      // OUTSIDE: try to start a trip, if still within the window and able to afford one.
      if (tick >= config.window.endTick) {
        return { kind: "dormant" };
      }
      const origin = state.station;
      const dest = pickDestination(env, origin, balance, config.fare, rng);
      if (dest === null) {
        return { kind: "dormant" };
      }
      const route = sharedLineRoute(env.world, origin, dest);
      if (route === null) {
        return { kind: "dormant" };
      }

      // START_TRIP: tap in at the origin, charge the fare, then ride at least the
      // travel time. The emitted balance is the balance after the charge.
      balance -= fareFor(env, origin, dest, config.fare);
      const nextTick = tick + minutesToTicks(route.minutes) + sampleTicks(config.jitterTicks, rng);
      state = { kind: "riding", dest, line: route.line };
      return { kind: "enter", station: origin, line: route.line, balance, dest, nextTick };
    },
  };
}
