import { describe, expect, it } from "vitest";
import { ACCOUNT_RIDER_TARGET } from "../../game/tuning";
import { distanceTable } from "../world/distance";
import { buildTimetable } from "../world/timetable";
import { world } from "../world/world";
import type { WorldEnv } from "../world-reading";
import { ATTACK_ACCOUNT_NAMESPACE, BENIGN_ACCOUNT_NAMESPACE } from "./account-namespace";
import { createAccountRiderSpawner } from "./account-rider-spawner";

/** A benign-namespace fixture, distinct from the shared production constant. */
const BENIGN_ACCOUNTS: readonly string[] = ["bench.a", "bench.b", "bench.c", "bench.d"];

/** A real `WorldEnv`, so driving an actor's `act()` needs no unsafe stand-in cast. */
const env: WorldEnv = {
  world,
  distances: distanceTable(world),
  timetable: buildTimetable(world),
};

/**
 * Drive an account-rider spawner over many ticks against a live count, recording every
 * admitted id and the station each account rider signs in at. `liveOf` models the count.
 */
function run(
  seed: number,
  liveOf: (tick: number) => number,
  ticks: number,
  benignAccounts: readonly string[] = BENIGN_ACCOUNTS,
) {
  const spawner = createAccountRiderSpawner({
    seed,
    world,
    target: ACCOUNT_RIDER_TARGET,
    benignAccounts,
  });
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

/**
 * Drive a spawner and collect every admitted rider's own emitted kiosk readings
 * (GH126-PLAN.md M2a seam 11): its account and its fumble count, by stepping the
 * actor's own `act()` at its `start()` tick.
 */
function runReadings(seed: number, benignAccounts: readonly string[], ticks: number) {
  const spawner = createAccountRiderSpawner({
    seed,
    world,
    target: ACCOUNT_RIDER_TARGET,
    benignAccounts,
  });
  const accounts: string[] = [];
  const fumbleCounts: number[] = [];
  for (let tick = 1; tick <= ticks; tick++) {
    // Always report zero live, so the spawner admits every arrival it can.
    const admissions = spawner.tick(tick, 0);
    for (const admission of admissions) {
      const startTick = admission.actor.start({ rng: () => 0 });
      if (startTick === "dormant") {
        continue;
      }
      const result = admission.actor.act({
        tick: startTick,
        env,
        rng: () => 0,
      });
      let fumbles = 0;
      for (const reading of result.readings) {
        if (reading.sensor === "kiosk") {
          accounts.push(reading.reading.account);
          if (reading.reading.outcome === "fail") {
            fumbles += 1;
          }
        }
      }
      fumbleCounts.push(fumbles);
    }
  }
  return { accounts, fumbleCounts };
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

// GH126-PLAN.md M2a item 4, seam 11: the spawner draws every benign victim from
// its given benign namespace, and reintroduces capped fumbles now that the
// namespace is disjoint from the attack range.
describe("createAccountRiderSpawner benign namespace and capped fumbles", () => {
  it("draws every benign account from the given namespace, none outside it", () => {
    const { accounts } = runReadings(7, BENIGN_ACCOUNTS, 3000);
    expect(accounts.length).toBeGreaterThan(0);
    for (const account of accounts) {
      expect(BENIGN_ACCOUNTS).toContain(account);
    }
  });

  it("integrates with the shared partition: draws only from BENIGN_ACCOUNT_NAMESPACE, never ATTACK_ACCOUNT_NAMESPACE", () => {
    const { accounts } = runReadings(7, BENIGN_ACCOUNT_NAMESPACE, 3000);
    const attackSet = new Set(ATTACK_ACCOUNT_NAMESPACE);
    expect(accounts.length).toBeGreaterThan(0);
    for (const account of accounts) {
      expect(attackSet.has(account)).toBe(false);
    }
  });

  it("caps every visit's fumble count at 2, below the pin-brute-force threshold", () => {
    const { fumbleCounts } = runReadings(7, BENIGN_ACCOUNTS, 3000);
    expect(fumbleCounts.length).toBeGreaterThan(0);
    for (const count of fumbleCounts) {
      expect(count).toBeLessThanOrEqual(2);
      expect(count).toBeGreaterThanOrEqual(0);
    }
    // At least one visit should fumble across this many draws, proving the
    // reintroduced behavior is actually live, not merely absent.
    expect(fumbleCounts.some((count) => count > 0)).toBe(true);
  });
});
