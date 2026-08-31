import { describe, expect, it } from "vitest";
import { GAME_SECONDS_PER_TICK } from "../../../game/tuning";
import { createSchedule } from "../../actors/actor";
import type { AccountKioskReading } from "../../endpoints/kiosk/internal";
import { distanceTable } from "../../world/distance";
import { buildTimetable } from "../../world/timetable";
import { world } from "../../world/world";
import type { WorldEnv, WorldReading } from "../../world-reading";
import { ARRIVE_LEAD_TICKS, createPinAttacker, type PinAttackerConfig } from "./pin-attacker";

const env: WorldEnv = {
  world,
  distances: distanceTable(world),
  timetable: buildTimetable(world),
};

/** A kiosk payload, narrowed off the discriminated union. */
function kioskOf(reading: WorldReading): AccountKioskReading {
  if (reading.sensor !== "kiosk") {
    throw new Error(`expected a kiosk reading, got "${reading.sensor}".`);
  }
  return reading.reading;
}

/** Step one attacker to dormancy, collecting its kiosk readings and its dormant tick. */
function run(config: PinAttackerConfig) {
  const schedule = createSchedule({ actors: [createPinAttacker(config)], env, runSeed: 1 });
  const readings: AccountKioskReading[] = [];
  let dormantAtTick: number | null = null;
  const lastTick = Math.max(...config.failTimestamps) / GAME_SECONDS_PER_TICK;
  for (let tick = 0; tick <= lastTick + 3; tick++) {
    const step = schedule.advanceTo(tick + 1);
    for (const timed of step.readings) {
      readings.push(kioskOf(timed.reading));
    }
    if (step.dormant.includes(config.id)) {
      dormantAtTick = tick;
    }
  }
  return { readings, dormantAtTick, activeAfter: schedule.activeIds().length };
}

// Fails at ticks 30..34, i.e. game seconds 60..68 (GAME_SECONDS_PER_TICK = 2).
const BASE: PinAttackerConfig = {
  id: "X1",
  account: "river.k",
  station: "har",
  terminal: "K1",
  failTimestamps: [60, 62, 64, 66, 68],
};

describe("createPinAttacker", () => {
  it("plays every fail timestamp exactly, one fail reading each, nothing else", () => {
    const { readings } = run(BASE);
    expect(readings.map((r) => r.ts)).toEqual([60, 62, 64, 66, 68]);
    for (const reading of readings) {
      expect(reading.outcome).toBe("fail");
      expect(reading.account).toBe("river.k");
      expect(reading.station).toBe("har");
      expect(reading.terminal).toBe("K1");
    }
  });

  it("emits nothing on arrival, before the first fail", () => {
    const schedule = createSchedule({ actors: [createPinAttacker(BASE)], env, runSeed: 1 });
    // The attacker arrives ARRIVE_LEAD_TICKS before the first fail (tick 30), at tick 10.
    const beforeFirstFail = schedule.advanceTo(30);
    expect(beforeFirstFail.readings).toHaveLength(0);
  });

  it("goes dormant right after the final fail", () => {
    const { dormantAtTick, activeAfter } = run(BASE);
    expect(dormantAtTick).toBe(34); // the last fail's tick
    expect(activeAfter).toBe(0);
  });

  it("rejects an empty fail list", () => {
    expect(() => createPinAttacker({ ...BASE, failTimestamps: [] })).toThrow();
  });

  it("rejects non-increasing timestamps", () => {
    expect(() => createPinAttacker({ ...BASE, failTimestamps: [64, 62] })).toThrow();
  });

  it("rejects a timestamp that is not tick-aligned", () => {
    // 61 game seconds is 30.5 ticks: not an integer tick.
    expect(() => createPinAttacker({ ...BASE, failTimestamps: [61] })).toThrow();
  });

  it("rejects a first fail earlier than ARRIVE_LEAD_TICKS", () => {
    // Tick 10 (ts 20) is inside the arrival lead, so the start tick would go negative.
    expect(ARRIVE_LEAD_TICKS).toBe(20);
    expect(() => createPinAttacker({ ...BASE, failTimestamps: [20] })).toThrow();
  });
});
