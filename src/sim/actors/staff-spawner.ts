/**
 * The staff population spawner: a deterministic, seeded source of transient staff.
 * The live run is perpetual, so a small cast is kept without unbounded growth. On each
 * tick it admits a fresh staff member whenever the live count is below the cap and an
 * arrival is due, minting a new id per birth and assigning a badge from a seeded pool.
 * Each visits one door-bearing location (a site or the OCC) and walks in from that
 * location's nearest station.
 *
 * All randomness comes from one seeded stream derived from the run seed, so the whole
 * admission sequence replays for a seed on one machine. No wall clock, no React
 * (ARCHITECTURE rule 8, ADR-0007). It mirrors the rider spawner: a seeded arrival
 * process capped at a target, not the prototype's timer.
 */
import { randomLcg } from "d3-random";
import {
  STAFF_ARRIVAL_MAX_TICKS,
  STAFF_ARRIVAL_MIN_TICKS,
  STAFF_BADGE_POOL,
  STAFF_DOOR_STEP_TICKS,
  STAFF_WALK_TICKS,
} from "../../game/tuning";
import { type Badge, buildBadges } from "../entities/badge";
import type { World } from "../world/world";
import type { WorldEnv, WorldReading } from "../world-reading";
import { type Admission, actorSeedHash } from "./actor";
import { seededArrivalProcess } from "./arrival-process";
import { createStaff, initialStaffPresence, type StaffConfig } from "./staff";

/** Everything the spawner needs. `seed` is the run seed; the spawner derives its own stream. */
export interface StaffSpawnerConfig {
  seed: number;
  world: World;
  /** The steady concurrent staff cap. The spawner never admits above it. */
  target: number;
}

/** A seeded staff source the engine ticks once per sim tick. */
export interface StaffSpawner {
  /**
   * The admissions due at `nowTick` given the current live staff count. Zero or more,
   * bounded so `liveStaff + result.length <= target`. Deterministic for the seed and
   * the sequence of `(nowTick, liveStaff)` inputs.
   */
  tick(nowTick: number, liveStaff: number): readonly Admission<WorldReading, WorldEnv>[];
}

/**
 * The OCC has no `nearestStation` in `world.json` (it is not a site), but staff still
 * walk to it. Central sits directly below the control center on the map, so a staff
 * visit to the OCC walks in from Central. Sites carry their own `nearestStation`.
 */
const OCC_NEAREST_STATION = "cen";

/** One door-bearing location a staff can visit: its id and the station to walk from. */
interface StaffDestination {
  location: string;
  nearestStation: string;
}

/** The door-bearing destinations: every site (with its nearest station) and the OCC. */
function destinations(world: World): readonly StaffDestination[] {
  return [
    ...world.sites.map((site) => ({ location: site.id, nearestStation: site.nearestStation })),
    { location: world.controlCenter.id, nearestStation: OCC_NEAREST_STATION },
  ];
}

export function createStaffSpawner(config: StaffSpawnerConfig): StaffSpawner {
  // A distinct seeded stream, keyed off the run seed but separate from every actor's,
  // so the spawn cadence never shares a stream with a staff member's own draws.
  const rng = randomLcg(actorSeedHash(config.seed, "staff-spawner"));
  const badges = buildBadges(STAFF_BADGE_POOL, rng);
  const places = destinations(config.world);

  let births = 0;

  const pick = <T>(items: readonly T[]): T | undefined => items[Math.floor(rng() * items.length)];

  const makeAdmission = (atTick: number): Admission<WorldReading, WorldEnv> => {
    const id = `S${String(births++).padStart(6, "0")}`;
    const badge: Badge = pick(badges) ?? { id: "B000", grade: 4 };
    const place = pick(places) ?? places[0];
    const nearestStation = place?.nearestStation ?? "cen";
    const staffConfig: StaffConfig = {
      id,
      badge,
      location: place?.location ?? "dep",
      nearestStation,
      startTick: atTick,
      walkTicks: STAFF_WALK_TICKS,
      stepTicks: STAFF_DOOR_STEP_TICKS,
    };
    return {
      actor: createStaff(staffConfig),
      kind: "staff",
      initialPresence: (firstTick) => initialStaffPresence(nearestStation, firstTick),
    };
  };

  return seededArrivalProcess({
    minGap: STAFF_ARRIVAL_MIN_TICKS,
    maxGap: STAFF_ARRIVAL_MAX_TICKS,
    rng,
    target: config.target,
    admit: makeAdmission,
  });
}
