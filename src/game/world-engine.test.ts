import { describe, expect, it } from "vitest";
import type { Actor, Admission } from "../sim/actors/actor";
import type { RiderSpawner } from "../sim/actors/rider-spawner";
import { createStaff, initialStaffPresence } from "../sim/actors/staff";
import { createTrain, initialTrainPresence } from "../sim/actors/train";
import { distanceTable } from "../sim/world/distance";
import { contactNodeId, gateNodeId, readerNodeId } from "../sim/world/layout";
import type { Presence } from "../sim/world/presence";
import { buildTimetable } from "../sim/world/timetable";
import { world } from "../sim/world/world";
import type { DoorContactReading, WorldEnv, WorldReading } from "../sim/world-reading";
import type { WorldSnapshot } from "../sim/world-snapshot";
import { ManualDriver } from "./clock";
import {
  CLOCK_HZ,
  DOOR_DWELL_TICKS,
  FLASH_WINDOW_TICKS,
  GAME_SECONDS_PER_TICK,
  PUBLISH_HZ,
  WORLD_LOG_RETENTION,
} from "./tuning";
import { startWorld, type WorldFixture } from "./world-engine";

const env: WorldEnv = { world, distances: distanceTable(world), timetable: buildTimetable(world) };

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
      // The flash lands on the station's gate chip, not the station center.
      expect(flash.node).toBe(gateNodeId("cen"));
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

/** A stub spawner that admits a fixed cast once, then nothing, so admits are testable. */
function scriptedSpawner(cards: readonly string[]): RiderSpawner {
  let admitted = false;
  return {
    tick: (nowTick) => {
      if (admitted) {
        return [];
      }
      admitted = true;
      return cards.map(
        (card): Admission<WorldReading, WorldEnv> => ({
          actor: tapper({ id: card, station: "cen", period: 5, startTick: nowTick }),
          kind: "rider",
          initialPresence: (firstTick) => ({
            kind: "at",
            node: "cen",
            fromTick: firstTick,
            untilTick: firstTick,
          }),
        }),
      );
    },
  };
}

describe("world engine spawner", () => {
  it("admits the spawner's transients and seeds their views", () => {
    const snapshots: WorldSnapshot[] = [];
    const driver = new ManualDriver();
    const handle = startWorld({
      fixtures: [],
      env,
      runSeed: 1,
      setWorldSnapshot: (snapshot) => snapshots.push(snapshot),
      driver,
      bindVisibility: noVisibility,
      spawner: scriptedSpawner(["C000000", "C000001"]),
    });
    tick(driver, 6);
    handle.stop();
    const last = snapshots.at(-1);
    expect(last?.actors.map((view) => view.id).sort()).toEqual(["C000000", "C000001"]);
    expect(last?.counts.riders).toBe(2);
  });
});

describe("world engine speed", () => {
  it("freezes the sim at speed 0 (paused)", () => {
    const acted: number[] = [];
    const driver = new ManualDriver();
    const handle = startWorld({
      fixtures: [fixtureAt(tapper({ id: "C1", station: "cen", period: 1, acted }), "cen")],
      env,
      runSeed: 1,
      setWorldSnapshot: () => undefined,
      driver,
      bindVisibility: noVisibility,
      getSpeed: () => 0,
    });
    tick(driver, 60);
    handle.stop();
    // No sim tick ran, so the actor never acted.
    expect(acted).toEqual([]);
  });

  it("accrues a fractional speed and fires whole ticks", () => {
    const acted: number[] = [];
    const driver = new ManualDriver();
    const handle = startWorld({
      fixtures: [fixtureAt(tapper({ id: "C1", station: "cen", period: 1, acted }), "cen")],
      env,
      runSeed: 1,
      setWorldSnapshot: () => undefined,
      driver,
      bindVisibility: noVisibility,
      getSpeed: () => 0.5,
    });
    // 0.5 per clock tick: a whole sim tick fires only every second clock tick, so
    // four clock ticks run exactly two sim ticks (0 and 1), never a fractional one.
    tick(driver, 4);
    handle.stop();
    expect(acted).toEqual([0, 1]);
  });

  it("advances multiple whole ticks per clock tick at speed > 1", () => {
    const acted: number[] = [];
    const driver = new ManualDriver();
    const handle = startWorld({
      fixtures: [fixtureAt(tapper({ id: "C1", station: "cen", period: 1, acted }), "cen")],
      env,
      runSeed: 1,
      setWorldSnapshot: () => undefined,
      driver,
      bindVisibility: noVisibility,
      getSpeed: () => 3,
    });
    // Three sim ticks per clock tick, so two clock ticks run ticks 0..5 in order.
    tick(driver, 2);
    handle.stop();
    expect(acted).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

describe("world engine event log", () => {
  it("keeps the log bounded and newest-first over a long run", () => {
    let last: WorldSnapshot | undefined;
    const driver = new ManualDriver();
    const handle = startWorld({
      fixtures: [fixtureAt(tapper({ id: "C1", station: "cen", period: 1 }), "cen")],
      env,
      runSeed: 1,
      setWorldSnapshot: (snapshot) => {
        last = snapshot;
      },
      driver,
      bindVisibility: noVisibility,
    });
    tick(driver, WORLD_LOG_RETENTION + 80);
    handle.stop();
    const log = last?.log ?? [];
    expect(log.length).toBeLessThanOrEqual(WORLD_LOG_RETENTION);
    expect(log.length).toBeGreaterThan(1);
    // Newest first: one tap per tick, so the ticks strictly decrease down the list.
    for (let i = 1; i < log.length; i++) {
      expect(log[i - 1]?.tick ?? 0).toBeGreaterThan(log[i]?.tick ?? 0);
    }
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

/** The four persistent train fixtures, one per line, exactly as the controller builds them. */
function trainFixtures(): WorldFixture[] {
  const timetable = env.timetable;
  return world.lines.map((line, index): WorldFixture => {
    const schedule = timetable.line(line.id);
    const origin = schedule.stops[0] ?? line.id;
    return {
      actor: createTrain({ id: `T${index + 1}`, line: line.id, startTick: schedule.startTick }),
      kind: "train",
      initialPresence: (firstTick) => initialTrainPresence(origin, firstTick, line.id),
    };
  });
}

describe("world engine trains", () => {
  it("seeds exactly one persistent train per line and counts them", () => {
    let last: WorldSnapshot | undefined;
    const driver = new ManualDriver();
    const handle = startWorld({
      fixtures: trainFixtures(),
      env,
      runSeed: 1,
      setWorldSnapshot: (snapshot) => {
        last = snapshot;
      },
      driver,
      bindVisibility: noVisibility,
    });
    tick(driver, 200);
    handle.stop();
    const trains = (last?.actors ?? []).filter((view) => view.kind === "train");
    expect(trains.map((view) => view.id).sort()).toEqual(["T1", "T2", "T3", "T4"]);
    expect(last?.counts.trains).toBe(4);
  });

  it("seeds a train's presence from its first tick, parked at its origin before it departs", () => {
    const snapshots: WorldSnapshot[] = [];
    const driver = new ManualDriver();
    const handle = startWorld({
      fixtures: trainFixtures(),
      env,
      runSeed: 1,
      setWorldSnapshot: (snapshot) => snapshots.push(snapshot),
      driver,
      bindVisibility: noVisibility,
    });
    // The Circle train (T4) launches later than the first publish, so it still sits at
    // its origin, seeded from initialTicks() via initialPresence(firstTick).
    tick(driver, 3);
    handle.stop();
    const circle = snapshots[0]?.actors.find((view) => view.id === "T4");
    expect(circle?.presence).toEqual({
      kind: "at",
      node: "cen",
      fromTick: 0,
      untilTick: 180,
      rail: { line: "circle", from: 0, to: 0 },
    });
  });

  it("flashes a train-tracker reading at the station node", () => {
    const snapshots: WorldSnapshot[] = [];
    const driver = new ManualDriver();
    const handle = startWorld({
      fixtures: trainFixtures(),
      env,
      runSeed: 1,
      setWorldSnapshot: (snapshot) => snapshots.push(snapshot),
      driver,
      bindVisibility: noVisibility,
    });
    tick(driver, 200);
    handle.stop();
    const flashes = snapshots.flatMap((snapshot) => snapshot.flashes);
    const trainFlashes = flashes.filter((flash) => flash.kind === "train");
    expect(trainFlashes.length).toBeGreaterThan(0);
    // The Red train departs Harbor at tick 0, so a train flash lands on the "har" node.
    expect(trainFlashes.some((flash) => flash.node === "har")).toBe(true);
  });
});

/** The door-contact payloads in a snapshot's log, narrowed off the reading union. */
function doorContacts(snapshot: WorldSnapshot | undefined): DoorContactReading[] {
  const contacts: DoorContactReading[] = [];
  for (const entry of snapshot?.log ?? []) {
    if (entry.reading.sensor === "door-contact") {
      contacts.push(entry.reading.reading);
    }
  }
  return contacts;
}

/** A staff fixture that visits Eastyard Depot and taps its doors low to high. */
function depotStaffFixture(): WorldFixture {
  const actor = createStaff({
    id: "S1",
    badge: { id: "B900", grade: 4 },
    location: "dep",
    nearestStation: "jct",
    startTick: 0,
    walkTicks: 1,
    stepTicks: 10,
  });
  return {
    actor,
    kind: "staff",
    initialPresence: (firstTick) => initialStaffPresence("jct", firstTick),
  };
}

describe("world engine doors", () => {
  it("flashes a grant at the door reader and opens the door via the reducer", () => {
    const snapshots: WorldSnapshot[] = [];
    const driver = new ManualDriver();
    const handle = startWorld({
      fixtures: [depotStaffFixture()],
      env,
      runSeed: 1,
      setWorldSnapshot: (snapshot) => snapshots.push(snapshot),
      driver,
      bindVisibility: noVisibility,
    });
    // Long enough for both taps (ticks 1 and 11) and their dwell closes.
    tick(driver, 30);
    handle.stop();

    const flashes = snapshots.flatMap((snapshot) => snapshot.flashes);
    // A grant flashes on the depot's door-reader (R) chip.
    const grants = flashes.filter((flash) => flash.kind === "grant");
    expect(grants.length).toBeGreaterThan(0);
    expect(grants.every((flash) => flash.node === readerNodeId("dep"))).toBe(true);
    // The door contact open/close flashes on the depot's door-contact (D) chip.
    const doorFlashes = flashes.filter((flash) => flash.kind === "door");
    expect(doorFlashes.length).toBeGreaterThan(0);
    expect(doorFlashes.every((flash) => flash.node === contactNodeId("dep"))).toBe(true);
  });

  it("emits door-contact open then close readings and toggles the door projection", () => {
    const snapshots: WorldSnapshot[] = [];
    const driver = new ManualDriver();
    const handle = startWorld({
      fixtures: [depotStaffFixture()],
      env,
      runSeed: 1,
      setWorldSnapshot: (snapshot) => snapshots.push(snapshot),
      driver,
      bindVisibility: noVisibility,
    });
    tick(driver, 30);
    handle.stop();

    // The door-contact readings the reducer emitted, in order, for STORE (the first door).
    const last = snapshots.at(-1);
    const store = doorContacts(last).filter((reading) => reading.door === "STORE");
    expect(store.map((reading) => reading.event)).toContain("open");
    expect(store.map((reading) => reading.event)).toContain("close");

    // A snapshot mid-dwell shows the door open; a late snapshot shows it closed again.
    const anyOpen = snapshots.some((snapshot) =>
      snapshot.doors.some((door) => door.node === contactNodeId("dep") && door.open),
    );
    expect(anyOpen).toBe(true);
    expect(last?.doors ?? []).toHaveLength(0);
  });

  it("closes a door exactly DOOR_DWELL_TICKS after the grant that opened it", () => {
    const snapshots: WorldSnapshot[] = [];
    const driver = new ManualDriver();
    const handle = startWorld({
      fixtures: [depotStaffFixture()],
      env,
      runSeed: 1,
      setWorldSnapshot: (snapshot) => snapshots.push(snapshot),
      driver,
      bindVisibility: noVisibility,
    });
    tick(driver, 30);
    handle.stop();

    const contacts = doorContacts(snapshots.at(-1));
    // STORE opens at tick 1 (game seconds 2) and closes at tick 1 + DOOR_DWELL_TICKS.
    const openTs = contacts.find((r) => r.door === "STORE" && r.event === "open")?.ts ?? Number.NaN;
    const closeTs =
      contacts.find((r) => r.door === "STORE" && r.event === "close")?.ts ?? Number.NaN;
    expect(closeTs - openTs).toBe(DOOR_DWELL_TICKS * GAME_SECONDS_PER_TICK);
  });

  it("counts staff and evicts them from the view when they leave", () => {
    let sawStaff = false;
    let last: WorldSnapshot | undefined;
    const driver = new ManualDriver();
    const handle = startWorld({
      fixtures: [depotStaffFixture()],
      env,
      runSeed: 1,
      setWorldSnapshot: (snapshot) => {
        if (snapshot.counts.staff > 0) {
          sawStaff = true;
        }
        last = snapshot;
      },
      driver,
      bindVisibility: noVisibility,
    });
    tick(driver, 60);
    handle.stop();
    expect(sawStaff).toBe(true);
    // After the visit the staff has walked out and despawned.
    expect(last?.counts.staff).toBe(0);
    expect((last?.actors ?? []).filter((view) => view.kind === "staff")).toHaveLength(0);
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
