/**
 * The rider population spawner: a deterministic, seeded source of transient riders.
 * The live run is perpetual, so a steady cast has to be kept without unbounded growth.
 * On each tick it admits a fresh rider whenever the live count is below the target and
 * an arrival is due, minting a new id per birth. The population is bounded by the
 * target (it never admits above it) and refills as riders finish and are evicted.
 *
 * All randomness comes from one seeded stream derived from the run seed, so the whole
 * admission sequence replays for a seed on one machine. No wall clock, no React
 * (ARCHITECTURE rule 8, ADR-0007). The prototype's fixed-22 instant-respawn is not the
 * model; this is a seeded arrival process capped at a target.
 */
import { randomLcg } from "d3-random";
import {
  RIDER_ARRIVAL_MAX_TICKS,
  RIDER_ARRIVAL_MIN_TICKS,
  RIDER_BALANCE,
  RIDER_WINDOW_TICKS,
} from "../../game/tuning";
import type { World } from "../world/world";
import type { WorldEnv, WorldReading } from "../world-reading";
import { type Admission, actorSeedHash } from "./actor";
import type { RiderTripConfig } from "./rider-core";
import { createWorldRider, initialRiderPresence } from "./world-rider";

/** Everything the spawner needs. `seed` is the run seed; the spawner derives its own stream. */
export interface RiderSpawnerConfig {
  seed: number;
  world: World;
  /** The steady concurrent rider count. The spawner never admits above it. */
  target: number;
}

/** A seeded rider source the engine ticks once per sim tick. */
export interface RiderSpawner {
  /**
   * The admissions due at `nowTick` given the current live rider count. Zero or more,
   * bounded so `liveRiders + result.length <= target`. Deterministic for the seed and
   * the sequence of `(nowTick, liveRiders)` inputs.
   */
  tick(nowTick: number, liveRiders: number): readonly Admission<WorldReading, WorldEnv>[];
}

/** The fare law and dwell/jitter every spawned rider carries. Benign, uniform. */
const RIDER_FARE = { base: 10, perMinute: 5 };
const RIDER_JITTER = { min: 0, max: 4 };
const RIDER_DWELL = { min: 2, max: 8 };

export function createRiderSpawner(config: RiderSpawnerConfig): RiderSpawner {
  // A distinct seeded stream, keyed off the run seed but separate from every actor's,
  // so the spawn cadence never shares a stream with a rider's own draws.
  const rng = randomLcg(actorSeedHash(config.seed, "rider-spawner"));
  const stations = config.world.stations;
  const gapSpan = RIDER_ARRIVAL_MAX_TICKS - RIDER_ARRIVAL_MIN_TICKS + 1;

  let births = 0;
  // The next tick at which an arrival is considered. Starts at 0 so the population
  // fills from the first tick, then advances by a seeded gap after each arrival.
  let nextArrival = 0;

  const drawGap = (): number => RIDER_ARRIVAL_MIN_TICKS + Math.floor(rng() * gapSpan);

  const makeAdmission = (atTick: number): Admission<WorldReading, WorldEnv> => {
    const id = `C${String(births++).padStart(6, "0")}`;
    const origin = stations[Math.floor(rng() * stations.length)]?.id ?? stations[0]?.id ?? "cen";
    const tripConfig: RiderTripConfig = {
      card: id,
      origin,
      balance: RIDER_BALANCE,
      window: { startTick: atTick, endTick: atTick + RIDER_WINDOW_TICKS },
      fare: RIDER_FARE,
      jitterTicks: RIDER_JITTER,
      dwellTicks: RIDER_DWELL,
    };
    return {
      actor: createWorldRider(tripConfig),
      kind: "rider",
      initialPresence: (firstTick) => initialRiderPresence(origin, firstTick),
    };
  };

  return {
    tick: (nowTick, liveRiders) => {
      const admissions: Admission<WorldReading, WorldEnv>[] = [];
      while (nextArrival <= nowTick) {
        if (liveRiders + admissions.length < config.target) {
          admissions.push(makeAdmission(nowTick));
        }
        // Advance past this arrival whether or not it was filled, so a full
        // population drops the arrival rather than backing up unboundedly.
        nextArrival += drawGap();
      }
      return admissions;
    },
  };
}
