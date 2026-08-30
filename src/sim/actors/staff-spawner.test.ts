import { describe, expect, it } from "vitest";
import { STAFF_TARGET } from "../../game/tuning";
import { world } from "../world/world";
import { createStaffSpawner } from "./staff-spawner";

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
