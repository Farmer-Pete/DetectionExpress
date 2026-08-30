import { describe, expect, it } from "vitest";
import { TARGET_RIDERS } from "../../game/tuning";
import { distanceTable } from "../world/distance";
import { buildTimetable } from "../world/timetable";
import { world } from "../world/world";
import type { WorldEnv } from "../world-reading";
import { createSchedule } from "./actor";
import { createRiderSpawner } from "./rider-spawner";

const env: WorldEnv = {
  world,
  distances: distanceTable(world),
  timetable: buildTimetable(world),
};

/**
 * Drive a spawner over many ticks against a shrinking-then-refilling live count and
 * record every admitted id. `liveOf` models how many riders are alive at a tick.
 */
function run(seed: number, liveOf: (tick: number, born: number) => number, ticks: number) {
  const spawner = createRiderSpawner({ seed, world, target: TARGET_RIDERS });
  const ids: string[] = [];
  const origins: string[] = [];
  let maxConcurrent = 0;
  let born = 0;
  for (let tick = 1; tick <= ticks; tick++) {
    const live = liveOf(tick, born);
    const admissions = spawner.tick(tick, live);
    // Bound: the spawner never pushes the population over the target.
    expect(live + admissions.length).toBeLessThanOrEqual(TARGET_RIDERS);
    for (const admission of admissions) {
      ids.push(admission.actor.id);
      const presence = admission.initialPresence(tick);
      if (presence.kind === "at") {
        origins.push(presence.node);
      }
      born += 1;
      maxConcurrent = Math.max(maxConcurrent, live + admissions.length);
    }
  }
  return { ids, origins, maxConcurrent };
}

describe("createRiderSpawner", () => {
  it("is deterministic for a seed: same inputs replay the same births", () => {
    const liveOf = (_tick: number, born: number) => Math.min(born, 0); // always 0 live -> fill fast
    const a = run(7, liveOf, 400);
    const b = run(7, liveOf, 400);
    expect(a.ids).toEqual(b.ids);
    expect(a.origins).toEqual(b.origins);
    expect(a.ids.length).toBeGreaterThan(0);
  });

  it("differs across seeds", () => {
    const liveOf = () => 0;
    const a = run(1, liveOf, 400);
    const b = run(2, liveOf, 400);
    expect(a.ids.length).toBeGreaterThan(0);
    expect(a.origins).not.toEqual(b.origins);
  });

  it("mints unique, monotonic ids", () => {
    const { ids } = run(3, () => 0, 400);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe("C000000");
  });

  it("never exceeds the target, even when the population is already full", () => {
    // Hold the live count pinned at the target: the spawner must admit nobody.
    const { ids } = run(9, () => TARGET_RIDERS, 400);
    expect(ids).toHaveLength(0);
  });

  it("refills after a population drop: nothing while full, then again once riders leave", () => {
    // Model a real drop: the population sits full, then five riders leave, so the
    // spawner must admit again to refill toward the target (full -> below -> admits).
    const spawner = createRiderSpawner({ seed: 9, world, target: TARGET_RIDERS });
    const admitTicks: number[] = [];

    // Phase 1: the population is full, so the spawner admits nobody.
    for (let tick = 1; tick <= 200; tick++) {
      expect(spawner.tick(tick, TARGET_RIDERS)).toHaveLength(0);
    }

    // Phase 2: five riders have left; the spawner refills, never past the target.
    let live = TARGET_RIDERS - 5;
    for (let tick = 201; tick <= 400; tick++) {
      const admissions = spawner.tick(tick, live);
      for (let i = 0; i < admissions.length; i++) {
        admitTicks.push(tick);
      }
      live += admissions.length; // each birth raises the live count back toward target
      expect(live).toBeLessThanOrEqual(TARGET_RIDERS);
    }

    expect(admitTicks.length).toBeGreaterThan(0);
    // It only admitted after the drop, never during the full phase.
    expect(admitTicks[0]).toBeGreaterThanOrEqual(201);
    // It refilled exactly the five that left, then held.
    expect(live).toBe(TARGET_RIDERS);
    expect(admitTicks).toHaveLength(5);
  });

  it("admits riders whose origins are real stations", () => {
    const { origins } = run(5, () => 0, 400);
    const stationIds = new Set(world.stations.map((station) => station.id));
    for (const origin of origins) {
      expect(stationIds.has(origin)).toBe(true);
    }
  });

  it("draws a spread of starting balances, so a fraction top up while most just ride", () => {
    // Admit a batch of riders (one balance draw each), run them all together, and see
    // which ones hit a TVM. A low draw leaves a rider too poor for its first fare, so it
    // tops up on arrival; a high draw funds its window. Both must appear: the plan wants
    // "a low rider visibly refilling", not every rider topping up.
    const seed = 4242;
    const spawner = createRiderSpawner({ seed, world, target: 40 });
    const actors = [];
    for (let tick = 1; tick <= 600 && actors.length < 40; tick++) {
      for (const admission of spawner.tick(tick, actors.length)) {
        actors.push(admission.actor);
      }
    }
    expect(actors.length).toBeGreaterThan(10);

    const schedule = createSchedule({ actors, env, runSeed: seed });
    const toppedUp = new Set<string>();
    const rode = new Set<string>();
    for (let tick = 0; tick < 2000; tick++) {
      for (const timed of schedule.advanceTo(tick + 1).readings) {
        if (timed.reading.sensor === "tvm") {
          toppedUp.add(timed.actorId);
        } else if (timed.reading.sensor === "fare-gate") {
          rode.add(timed.actorId);
        }
      }
    }
    // Some riders arrive too poor and refill at a TVM.
    expect(toppedUp.size).toBeGreaterThan(0);
    // Others ride their whole window without ever topping up.
    const rodeWithoutTopup = [...rode].filter((id) => !toppedUp.has(id));
    expect(rodeWithoutTopup.length).toBeGreaterThan(0);
  });
});
