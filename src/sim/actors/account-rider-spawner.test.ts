import { describe, expect, it } from "vitest";
import { ACCOUNT_RIDER_TARGET } from "../../game/tuning";
import { world } from "../world/world";
import { createAccountRiderSpawner } from "./account-rider-spawner";

/**
 * Drive an account-rider spawner over many ticks against a live count, recording every
 * admitted id and the station each account rider signs in at. `liveOf` models the count.
 */
function run(seed: number, liveOf: (tick: number) => number, ticks: number) {
  const spawner = createAccountRiderSpawner({ seed, world, target: ACCOUNT_RIDER_TARGET });
  const ids: string[] = [];
  const stations: string[] = [];
  for (let tick = 1; tick <= ticks; tick++) {
    const live = liveOf(tick);
    const admissions = spawner.tick(tick, live);
    // Bound: the spawner never pushes the population over the target.
    expect(live + admissions.length).toBeLessThanOrEqual(ACCOUNT_RIDER_TARGET);
    for (const admission of admissions) {
      expect(admission.kind).toBe("account-rider");
      ids.push(admission.actor.id);
      const presence = admission.initialPresence(tick);
      if (presence.kind === "at") {
        stations.push(presence.node);
      }
    }
  }
  return { ids, stations };
}

describe("createAccountRiderSpawner", () => {
  it("is deterministic for a seed: same inputs replay the same births", () => {
    const a = run(7, () => 0, 3000);
    const b = run(7, () => 0, 3000);
    expect(a.ids).toEqual(b.ids);
    expect(a.stations).toEqual(b.stations);
    expect(a.ids.length).toBeGreaterThan(0);
  });

  it("differs across seeds", () => {
    const a = run(1, () => 0, 3000);
    const b = run(2, () => 0, 3000);
    expect(a.ids.length).toBeGreaterThan(0);
    expect(a.stations).not.toEqual(b.stations);
  });

  it("mints unique, monotonic account-rider ids", () => {
    const { ids } = run(3, () => 0, 3000);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe("A000000");
  });

  it("never exceeds the cap, even when the population is already full", () => {
    const { ids } = run(9, () => ACCOUNT_RIDER_TARGET, 3000);
    expect(ids).toHaveLength(0);
  });

  it("signs in at real stations of the world", () => {
    const { stations } = run(5, () => 0, 3000);
    const stationIds = new Set(world.stations.map((station) => station.id));
    expect(stations.length).toBeGreaterThan(0);
    for (const station of stations) {
      expect(stationIds.has(station)).toBe(true);
    }
  });
});
