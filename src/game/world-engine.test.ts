import { describe, expect, it } from "vitest";
import type { Actor } from "../sim/actors/actor";
import { distanceTable } from "../sim/world/distance";
import type { Presence } from "../sim/world/presence";
import { world } from "../sim/world/world";
import type { WorldEnv, WorldReading } from "../sim/world-reading";
import type { WorldSnapshot } from "../sim/world-snapshot";
import { ManualDriver } from "./clock";
import { CLOCK_HZ, FLASH_WINDOW_TICKS, GAME_SECONDS_PER_TICK, PUBLISH_HZ } from "./tuning";
import { startWorld, type WorldFixture } from "./world-engine";

const env: WorldEnv = { world, distances: distanceTable(world) };

/** No-op visibility so the loop never pauses on a hidden document in tests. */
const noVisibility = (): (() => void) => () => undefined;

interface TapperConfig {
  id: string;
  station: string;
  period: number;
  startTick?: number;
  /** Total taps before going dormant. Omitted means it taps forever. */
  taps?: number;
  /** A sink the stub pushes each acted tick into, to prove the tick cadence. */
  acted?: number[];
}

/**
 * A test-only stub actor. It reschedules forward every `period` ticks, reports an
 * `at` presence, and emits a fare-gate `WorldReading`. It proves the
 * tick -> step -> snapshot path without any shipped actor.
 */
function tapper(config: TapperConfig): Actor<WorldReading, WorldEnv> {
  let count = 0;
  return {
    id: config.id,
    start: () => config.startTick ?? 0,
    act: ({ tick }) => {
      config.acted?.push(tick);
      count += 1;
      const reading: WorldReading = {
        sensor: "fare-gate",
        reading: {
          ts: tick * GAME_SECONDS_PER_TICK,
          card: config.id,
          station: config.station,
          line: "blue",
          direction: "in",
          result: "ok",
          balance: 100,
        },
      };
      const presence: Presence = {
        kind: "at",
        node: config.station,
        fromTick: tick,
        untilTick: tick + config.period,
      };
      const more = config.taps === undefined || count < config.taps;
      return { readings: [reading], nextTick: more ? tick + config.period : "dormant", presence };
    },
  };
}

/** Wrap a stub as a startup fixture whose initial presence records its first tick. */
function fixtureAt(actor: Actor<WorldReading, WorldEnv>, station: string): WorldFixture {
  return {
    actor,
    kind: "rider",
    initialPresence: (firstTick) => ({
      kind: "at",
      node: station,
      fromTick: 0,
      untilTick: firstTick,
    }),
  };
}

function tick(driver: ManualDriver, times: number): void {
  for (let i = 0; i < times; i++) {
    driver.tick();
  }
}

describe("world engine cadence", () => {
  it("advances exactly one integer tick per step, one step per clock tick", () => {
    const acted: number[] = [];
    const driver = new ManualDriver();
    const handle = startWorld({
      fixtures: [fixtureAt(tapper({ id: "C1", station: "cen", period: 1, acted }), "cen")],
      env,
      runSeed: 1,
      setWorldSnapshot: () => undefined,
      driver,
      bindVisibility: noVisibility,
    });
    tick(driver, 60);
    handle.stop();
    // One act per integer tick, in order, no fractional tick and no skip.
    expect(acted).toEqual(Array.from({ length: 60 }, (_, i) => i));
  });

  it("publishes at PUBLISH_HZ", () => {
    const snapshots: WorldSnapshot[] = [];
    const driver = new ManualDriver();
    const handle = startWorld({
      fixtures: [fixtureAt(tapper({ id: "C1", station: "cen", period: 1 }), "cen")],
      env,
      runSeed: 1,
      setWorldSnapshot: (snapshot) => snapshots.push(snapshot),
      driver,
      bindVisibility: noVisibility,
    });
    tick(driver, CLOCK_HZ); // one second of clock ticks
    handle.stop();
    // CLOCK_HZ ticks / (CLOCK_HZ / PUBLISH_HZ) per publish == PUBLISH_HZ publishes.
    expect(snapshots).toHaveLength(PUBLISH_HZ);
    expect(snapshots.at(-1)?.nowTick).toBe(CLOCK_HZ);
  });
});

describe("world engine snapshot", () => {
  it("seeds a fixture's presence from its first tick before it acts", () => {
    const snapshots: WorldSnapshot[] = [];
    const driver = new ManualDriver();
    const handle = startWorld({
      // Starts at tick 5, so after 3 clock ticks it has not acted yet.
      fixtures: [fixtureAt(tapper({ id: "C1", station: "cen", period: 4, startTick: 5 }), "cen")],
      env,
      runSeed: 1,
      setWorldSnapshot: (snapshot) => snapshots.push(snapshot),
      driver,
      bindVisibility: noVisibility,
    });
    tick(driver, 3); // first publish at clock tick 3; the stub (tick 5) has not acted
    handle.stop();
    const first = snapshots[0];
    expect(first?.actors).toHaveLength(1);
    // initialPresence(firstTick) was called with the seeded first tick, 5.
    expect(first?.actors[0]?.presence).toEqual({
      kind: "at",
      node: "cen",
      fromTick: 0,
      untilTick: 5,
    });
    expect(first?.counts.riders).toBe(1);
  });

  it("folds a tap into a flash at the tapped node", () => {
    const snapshots: WorldSnapshot[] = [];
    const driver = new ManualDriver();
    const handle = startWorld({
      fixtures: [fixtureAt(tapper({ id: "C1", station: "cen", period: 3 }), "cen")],
      env,
      runSeed: 1,
      setWorldSnapshot: (snapshot) => snapshots.push(snapshot),
      driver,
      bindVisibility: noVisibility,
    });
    tick(driver, 12);
    handle.stop();
    const last = snapshots.at(-1);
    const flashes = last?.flashes ?? [];
    expect(flashes.length).toBeGreaterThan(0);
    for (const flash of flashes) {
      expect(flash.kind).toBe("tap");
      expect(flash.node).toBe("cen");
    }
  });

  it("evicts a dormant fixture from the view", () => {
    const snapshots: WorldSnapshot[] = [];
    const driver = new ManualDriver();
    const handle = startWorld({
      // Two taps (ticks 0 and 1), then dormant.
      fixtures: [fixtureAt(tapper({ id: "C1", station: "cen", period: 1, taps: 2 }), "cen")],
      env,
      runSeed: 1,
      setWorldSnapshot: (snapshot) => snapshots.push(snapshot),
      driver,
      bindVisibility: noVisibility,
    });
    tick(driver, 12);
    handle.stop();
    const last = snapshots.at(-1);
    expect(last?.actors).toHaveLength(0);
    expect(last?.counts.riders).toBe(0);
  });
});

describe("world engine bounded cost", () => {
  it("keeps flashes bounded over a long run", () => {
    let maxFlashes = 0;
    const driver = new ManualDriver();
    const handle = startWorld({
      fixtures: [fixtureAt(tapper({ id: "C1", station: "cen", period: 1 }), "cen")],
      env,
      runSeed: 1,
      setWorldSnapshot: (snapshot) => {
        maxFlashes = Math.max(maxFlashes, snapshot.flashes.length);
      },
      driver,
      bindVisibility: noVisibility,
    });
    tick(driver, 5000);
    handle.stop();
    // One flash per tick, pruned to the window, so it never grows without bound.
    expect(maxFlashes).toBeLessThanOrEqual(FLASH_WINDOW_TICKS + 1);
  });
});

describe("world engine lifecycle", () => {
  it("stops advancing after stop() and settles whenStopped", async () => {
    const acted: number[] = [];
    const driver = new ManualDriver();
    const handle = startWorld({
      fixtures: [fixtureAt(tapper({ id: "C1", station: "cen", period: 1, acted }), "cen")],
      env,
      runSeed: 1,
      setWorldSnapshot: () => undefined,
      driver,
      bindVisibility: noVisibility,
    });
    tick(driver, 5);
    handle.stop();
    const afterStop = acted.length;
    tick(driver, 5); // no effect: the driver is detached
    expect(acted.length).toBe(afterStop);
    await expect(handle.whenStopped).resolves.toBeUndefined();
  });
});
