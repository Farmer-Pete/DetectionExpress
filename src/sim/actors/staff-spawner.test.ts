import { describe, expect, it } from "vitest";
import { STAFF_TARGET } from "../../game/tuning";
import { distanceTable } from "../world/distance";
import { metroLayout } from "../world/layout";
import { buildTimetable } from "../world/timetable";
import { world } from "../world/world";
import type { WorldEnv } from "../world-reading";
import { createSchedule } from "./actor";
import { createStaffSpawner, staffWalkTicks } from "./staff-spawner";

describe("staffWalkTicks", () => {
  it("floors to STAFF_WALK_MIN_TICKS (6) at zero distance", () => {
    expect(staffWalkTicks(0)).toBe(6);
  });

  it("rounds distance / STAFF_WALK_SPEED (5) to the nearest whole tick", () => {
    expect(staffWalkTicks(48)).toBe(10); // 48 / 5 = 9.6 -> 10
    expect(staffWalkTicks(71)).toBe(14); // 71 / 5 = 14.2 -> 14
    expect(staffWalkTicks(60)).toBe(12); // 60 / 5 = 12 exactly
    expect(staffWalkTicks(389)).toBe(78); // 389 / 5 = 77.8 -> 78
  });

  it("rounds a half-tick distance up (Math.round convention)", () => {
    expect(staffWalkTicks(52.5)).toBe(11); // 52.5 / 5 = 10.5 -> 11
  });

  it("still floors at STAFF_WALK_MIN_TICKS for a short distance under the floor", () => {
    expect(staffWalkTicks(20)).toBe(6); // 20 / 5 = 4, floored to 6
  });
});

/**
 * Drive a staff spawner over many ticks against a live count and record every admitted
 * id and the station each staff walks in from. `liveOf` models the concurrent count.
 */
function run(seed: number, liveOf: (tick: number) => number, ticks: number) {
  const spawner = createStaffSpawner({ seed, world, target: STAFF_TARGET });
  const ids: string[] = [];
  const stations: string[] = [];
  for (let tick = 1; tick <= ticks; tick++) {
    const live = liveOf(tick);
    const admissions = spawner.tick(tick, live);
    // Bound: the spawner never pushes the population over the target.
    expect(live + admissions.length).toBeLessThanOrEqual(STAFF_TARGET);
    for (const admission of admissions) {
      expect(admission.kind).toBe("staff");
      ids.push(admission.actor.id);
      const presence = admission.initialPresence(tick);
      if (presence.kind === "at") {
        stations.push(presence.node);
      }
    }
  }
  return { ids, stations };
}

describe("createStaffSpawner", () => {
  it("is deterministic for a seed: same inputs replay the same births", () => {
    const a = run(7, () => 0, 2000);
    const b = run(7, () => 0, 2000);
    expect(a.ids).toEqual(b.ids);
    expect(a.stations).toEqual(b.stations);
    expect(a.ids.length).toBeGreaterThan(0);
  });

  it("differs across seeds", () => {
    const a = run(1, () => 0, 2000);
    const b = run(2, () => 0, 2000);
    expect(a.ids.length).toBeGreaterThan(0);
    expect(a.stations).not.toEqual(b.stations);
  });

  it("mints unique, monotonic staff ids", () => {
    const { ids } = run(3, () => 0, 2000);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe("S000000");
  });

  it("never exceeds the cap, even when the population is already full", () => {
    const { ids } = run(9, () => STAFF_TARGET, 2000);
    expect(ids).toHaveLength(0);
  });

  it("gives each staff a distance-coupled walkTicks, matching staffWalkTicks(station->site distance)", () => {
    const layout = metroLayout(world);
    const distanceOf = (nearestStation: string, location: string): number => {
      const from = layout.get(nearestStation);
      const to = layout.get(location);
      if (from === undefined || to === undefined) {
        throw new Error(`missing layout point for "${nearestStation}" or "${location}".`);
      }
      return Math.hypot(to.x - from.x, to.y - from.y);
    };
    const env: WorldEnv = {
      world,
      distances: distanceTable(world),
      timetable: buildTimetable(world),
    };
    const doorLocations = [...world.sites.map((site) => site.id), world.controlCenter.id];
    const seenLocations = new Set<string>();
    const spawner = createStaffSpawner({ seed: 11, world, target: STAFF_TARGET });

    for (let tick = 1; tick <= 3000 && seenLocations.size < doorLocations.length; tick++) {
      for (const admission of spawner.tick(tick, 0)) {
        // Run just this one staff to its first walk-in presence, which reports the
        // station->site walk as a "moving" span whose length is its walkTicks.
        const schedule = createSchedule({ actors: [], env, runSeed: 1 });
        const firstTick = schedule.admit(admission);
        const step = schedule.advanceTo(firstTick + 1);
        const presence = step.presences.get(admission.actor.id);
        if (presence?.kind !== "moving") {
          continue;
        }
        seenLocations.add(presence.to);
        const expected = staffWalkTicks(distanceOf(presence.from, presence.to));
        expect(presence.untilTick - presence.fromTick).toBe(expected);
      }
    }
    expect(seenLocations).toEqual(new Set(doorLocations));
  });

  it("walks staff in from the nearest station of a door-bearing location", () => {
    const { stations } = run(5, () => 0, 2000);
    // Each door-bearing location (every site, plus the OCC) has exactly one station a
    // staffer walks in from. The OCC carries no nearestStation of its own; staff reach it
    // from Central ("cen"), matching the spawner's OCC_NEAREST_STATION. This set is a
    // strict subset of all stations, so it is a tighter check than mere membership.
    const doorLocationStations = new Set<string>([
      ...world.sites.map((site) => site.nearestStation),
      "cen",
    ]);
    const allStations = new Set(world.stations.map((station) => station.id));
    expect(doorLocationStations.size).toBeLessThan(allStations.size);
    expect(stations.length).toBeGreaterThan(0);
    for (const station of stations) {
      // The origin pairs with a door-bearing location, not just any station on the map.
      expect(doorLocationStations.has(station)).toBe(true);
    }
  });
});
