import { describe, expect, it } from "vitest";
import type { Actor } from "../sim/actors/actor";
import { distanceTable } from "../sim/world/distance";
import { cameraNodeId, gateIdForStation, gateNodeId } from "../sim/world/layout";
import type { Presence } from "../sim/world/presence";
import { buildTimetable } from "../sim/world/timetable";
import { world } from "../sim/world/world";
import type { CameraReading, WorldEnv, WorldReading } from "../sim/world-reading";
import type { WorldSnapshot } from "../sim/world-snapshot";
import { ManualDriver } from "./clock";
import { GAME_SECONDS_PER_TICK, WORLD_LOG_RETENTION } from "./tuning";
import { startWorld, type WorldFixture } from "./world-engine";

const env: WorldEnv = { world, distances: distanceTable(world), timetable: buildTimetable(world) };

/** No-op visibility so the loop never pauses on a hidden document in tests. */
const noVisibility = (): (() => void) => () => undefined;

/** A stub that taps a station's fare gate (result "ok") every `period` ticks. */
function tapper(id: string, station: string, period: number): Actor<WorldReading, WorldEnv> {
  return {
    id,
    start: () => 0,
    act: ({ tick }) => {
      const reading: WorldReading = {
        sensor: "fare-gate",
        reading: {
          ts: tick * GAME_SECONDS_PER_TICK,
          card: id,
          station,
          line: "blue",
          direction: "in",
          result: "ok",
          balance: 100,
        },
      };
      const presence: Presence = {
        kind: "at",
        node: station,
        fromTick: tick,
        untilTick: tick + period,
      };
      return { readings: [reading], nextTick: tick + period, presence };
    },
  };
}

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

/** The platform-camera readings in a snapshot's log, narrowed off the union. */
function cameraReadings(snapshot: WorldSnapshot | undefined): CameraReading[] {
  const out: CameraReading[] = [];
  for (const entry of snapshot?.log ?? []) {
    if (entry.reading.sensor === "platform-camera") {
      out.push(entry.reading.reading);
    }
  }
  return out;
}

describe("gateIdForStation", () => {
  it("agrees with the gate node a fare-gate tap flashes on", () => {
    for (const station of world.stations) {
      expect(gateIdForStation(station.id)).toBe(gateNodeId(station.id));
    }
  });
});

describe("world engine camera (M5)", () => {
  it("emits a platform-camera reading carrying the station, gate, and matching counts", () => {
    const snapshots: WorldSnapshot[] = [];
    const driver = new ManualDriver();
    const handle = startWorld({
      fixtures: [fixtureAt(tapper("C1", "cen", 1), "cen")],
      env,
      runSeed: 1,
      setWorldSnapshot: (snapshot) => snapshots.push(snapshot),
      driver,
      bindVisibility: noVisibility,
    });
    tick(driver, 20);
    handle.stop();

    const cameras = cameraReadings(snapshots.at(-1));
    expect(cameras.length).toBeGreaterThan(0);
    const latest = cameras[0];
    expect(latest?.station).toBe("cen");
    expect(latest?.gate).toBe(gateIdForStation("cen"));
    // A steady tapper has more than one tap inside the window; benign, so the two agree.
    expect(latest?.grants).toBeGreaterThan(1);
    expect(latest?.persons).toBe(latest?.grants);
  });

  it("populates the crowd density mark at the station's camera (C) chip", () => {
    const snapshots: WorldSnapshot[] = [];
    const driver = new ManualDriver();
    const handle = startWorld({
      fixtures: [fixtureAt(tapper("C1", "cen", 1), "cen")],
      env,
      runSeed: 1,
      setWorldSnapshot: (snapshot) => snapshots.push(snapshot),
      driver,
      bindVisibility: noVisibility,
    });
    tick(driver, 20);
    handle.stop();

    const crowds = snapshots.at(-1)?.crowds ?? [];
    const cen = crowds.find((crowd) => crowd.node === cameraNodeId("cen"));
    expect(cen).toBeDefined();
    expect(cen?.grants).toBeGreaterThan(1);
    // Benign crowd: the bodies the camera sees equal the taps it counted.
    expect(cen?.persons).toBe(cen?.grants);
  });

  it("keeps the crowds and the camera log bounded over a long run", () => {
    let last: WorldSnapshot | undefined;
    let maxCrowds = 0;
    let maxLog = 0;
    const driver = new ManualDriver();
    const handle = startWorld({
      // Two stations tapping, so more than one gate carries a crowd mark.
      fixtures: [
        fixtureAt(tapper("C1", "cen", 1), "cen"),
        fixtureAt(tapper("C2", "mkt", 2), "mkt"),
      ],
      env,
      runSeed: 1,
      setWorldSnapshot: (snapshot) => {
        maxCrowds = Math.max(maxCrowds, snapshot.crowds.length);
        maxLog = Math.max(maxLog, snapshot.log.length);
        last = snapshot;
      },
      driver,
      bindVisibility: noVisibility,
    });
    tick(driver, 5000);
    handle.stop();

    // One crowd mark per active gate: bounded by the station count, never the run length.
    expect(maxCrowds).toBeLessThanOrEqual(world.stations.length);
    expect(maxCrowds).toBeGreaterThanOrEqual(2);
    // The event log stays bounded even with camera readings streaming into it.
    expect(maxLog).toBeLessThanOrEqual(WORLD_LOG_RETENTION);
    // The camera is still reporting at the end of the run.
    expect(cameraReadings(last).length).toBeGreaterThan(0);
  });
});
