import { describe, expect, it } from "vitest";
import { GAME_SECONDS_PER_TICK } from "../../game/tuning";
import { controlReference } from "../entities/control";
import { distanceTable } from "../world/distance";
import { buildTimetable } from "../world/timetable";
import { world } from "../world/world";
import type { RelayReading, WorldEnv, WorldReading } from "../world-reading";
import { createSchedule } from "./actor";
import { createHost, type HostConfig, initialHostPresence } from "./host";

const env: WorldEnv = {
  world,
  distances: distanceTable(world),
  timetable: buildTimetable(world),
  control: controlReference,
};

const CONFIG: HostConfig = {
  id: "H1",
  site: "dep",
  host: "YARD-NET-1",
  startTick: 0,
  cadenceTicks: 12,
};

/** A relay payload, narrowed off the discriminated union. */
function relayOf(reading: WorldReading): RelayReading {
  if (reading.sensor !== "network-relay") {
    throw new Error(`expected a network-relay reading, got "${reading.sensor}".`);
  }
  return reading.reading;
}

/** Step one host to a horizon, collecting its relay readings and presences. */
function runHost(config: HostConfig, horizon: number) {
  const schedule = createSchedule({ actors: [createHost(config)], env, runSeed: 7 });
  const readings: { tick: number; reading: RelayReading }[] = [];
  const presences = [];
  for (let tick = 0; tick < horizon; tick++) {
    const step = schedule.advanceTo(tick + 1);
    for (const timed of step.readings) {
      readings.push({ tick, reading: relayOf(timed.reading) });
    }
    const presence = step.presences.get(config.id);
    if (presence !== undefined) {
      presences.push({ tick, presence });
    }
  }
  return { readings, presences, schedule };
}

describe("createHost", () => {
  it("relays benign bytes within range to a benign destination, in the network-relay shape", () => {
    const { readings } = runHost(CONFIG, 200);
    expect(readings.length).toBeGreaterThan(0);
    const { min, max } = controlReference.byteRange;
    const destSet = new Set(controlReference.destinations);
    for (const { reading } of readings) {
      // The exact field set from the sensor data: ts, site, host, dest, bytes.
      expect(Object.keys(reading).sort()).toEqual(["bytes", "dest", "host", "site", "ts"].sort());
      expect(reading.site).toBe(CONFIG.site);
      expect(reading.host).toBe(CONFIG.host);
      // The destination is from the authorized internal set, never invented.
      expect(destSet.has(reading.dest)).toBe(true);
      // The byte count stays within the benign whole-byte range.
      expect(Number.isInteger(reading.bytes)).toBe(true);
      expect(reading.bytes).toBeGreaterThanOrEqual(min);
      expect(reading.bytes).toBeLessThanOrEqual(max);
    }
  });

  it("stamps ts in the game-second domain and fires at its cadence", () => {
    const { readings } = runHost({ ...CONFIG, startTick: 3, cadenceTicks: 12 }, 100);
    const ticks = readings.map((entry) => entry.tick);
    expect(ticks.slice(0, 3)).toEqual([3, 15, 27]);
    for (const entry of readings) {
      expect(entry.reading.ts).toBe(entry.tick * GAME_SECONDS_PER_TICK);
    }
  });

  it("is deterministic: the same seed reproduces the same relay stream", () => {
    const a = runHost(CONFIG, 200).readings.map((e) => `${e.reading.dest}|${e.reading.bytes}`);
    const b = runHost(CONFIG, 200).readings.map((e) => `${e.reading.dest}|${e.reading.bytes}`);
    expect(a).toEqual(b);
  });

  it("is a persistent fixture: never dormant, always at its site (a fixed node)", () => {
    const { presences, schedule } = runHost(CONFIG, 500);
    expect(schedule.activeIds()).toContain(CONFIG.id);
    for (const { presence } of presences) {
      expect(presence.kind).toBe("at");
      if (presence.kind === "at") {
        expect(presence.node).toBe(CONFIG.site);
      }
    }
  });

  it("seeds its initial presence at its site until its first relay", () => {
    expect(initialHostPresence("dep", 24)).toEqual({
      kind: "at",
      node: "dep",
      fromTick: 0,
      untilTick: 24,
    });
  });

  it("appears in the schedule's initial ticks (present from the start)", () => {
    const schedule = createSchedule({ actors: [createHost(CONFIG)], env, runSeed: 7 });
    expect(schedule.initialTicks().get(CONFIG.id)).toBe(CONFIG.startTick);
  });
});
