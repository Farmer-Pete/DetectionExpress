import { describe, expect, it } from "vitest";
import { GAME_SECONDS_PER_TICK } from "../../game/tuning";
import { distanceTable } from "../world/distance";
import { buildTimetable } from "../world/timetable";
import { world } from "../world/world";
import type { WorldEnv, WorldReading } from "../world-reading";
import { createSchedule } from "./actor";
import { createRider } from "./rider";
import type { RiderTripConfig } from "./rider-core";
import { createWorldRider, initialRiderPresence } from "./world-rider";

const distances = distanceTable(world);
const env: WorldEnv = { world, distances, timetable: buildTimetable(world) };

/** The tap direction of a reading, narrowed off the discriminated union (world riders emit only fare-gate). */
function directionOf(timed: { reading: WorldReading } | undefined): "in" | "out" | undefined {
  if (timed === undefined) {
    return undefined;
  }
  const reading = timed.reading;
  return reading.sensor === "fare-gate" ? reading.reading.direction : undefined;
}

const HORIZON = 1000;

const base: RiderTripConfig = {
  card: "C09",
  origin: "cen",
  balance: 1000,
  window: { startTick: 0, endTick: HORIZON - 400 },
  fare: { base: 10, perMinute: 5 },
  jitterTicks: { min: 0, max: 4 },
  dwellTicks: { min: 2, max: 6 },
};

/** Step one actor one tick at a time to the horizon, collecting each non-empty step. */
function stepThrough(config: RiderTripConfig, runSeed: number) {
  const rider = createWorldRider(config);
  const schedule = createSchedule({ actors: [rider], env, runSeed });
  const steps: {
    tick: number;
    readings: { reading: WorldReading; actorId: string }[];
    presence: ReturnType<typeof schedule.advanceTo>["presences"];
  }[] = [];
  for (let tick = 0; tick < HORIZON; tick++) {
    const step = schedule.advanceTo(tick + 1);
    if (step.readings.length > 0 || step.presences.size > 0) {
      steps.push({
        tick,
        readings: step.readings.map((timed) => ({
          reading: timed.reading,
          actorId: timed.actorId,
        })),
        presence: step.presences,
      });
    }
  }
  return { steps };
}

describe("createWorldRider", () => {
  it("emits fare-gate taps whose sequence matches createRider for the same seed", () => {
    // The world rider shares the trip core with the batch rider, so a funded rider's
    // fare-gate readings must be byte-identical for a seed. This pins that the native
    // actor did not drift from the GH30 model.
    const worldRider = createWorldRider(base);
    const wSchedule = createSchedule({ actors: [worldRider], env, runSeed: 4242 });
    const worldReadings = wSchedule
      .advanceTo(HORIZON)
      .readings.map((timed) => timed.reading.reading);

    const batchRider = createRider(base);
    const bSchedule = createSchedule({ actors: [batchRider], env, runSeed: 4242 });
    const batchReadings = bSchedule.advanceTo(HORIZON).readings.map((timed) => timed.reading);

    expect(worldReadings).toEqual(batchReadings);
    expect(worldReadings.length).toBeGreaterThan(0);
  });

  it("taps in, then out, alternating, and every reading is a fare-gate reading", () => {
    const worldRider = createWorldRider(base);
    const schedule = createSchedule({ actors: [worldRider], env, runSeed: 4242 });
    const readings = schedule.advanceTo(HORIZON).readings;
    readings.forEach((timed, index) => {
      expect(timed.reading.sensor).toBe("fare-gate");
      expect(directionOf(timed)).toBe(index % 2 === 0 ? "in" : "out");
    });
  });

  it("reports moving on the ride and at while dwelling, with untilTick the next tick", () => {
    const { steps } = stepThrough(base, 4242);
    // The first transition is a tap-in: it starts a ride, so its presence is moving.
    const first = steps[0];
    const firstReading = first?.readings[0];
    const firstPresence = first?.presence.get("C09");
    expect(directionOf(firstReading)).toBe("in");
    expect(firstPresence?.kind).toBe("moving");
    if (firstPresence?.kind === "moving") {
      expect(firstPresence.from).toBe(firstReading?.reading.reading.station);
      expect(firstPresence.line).toBe(firstReading?.reading.reading.line);
      expect(firstPresence.fromTick).toBe(first?.tick);
      // The moving presence ends at the arrival tick, which is the next step's tick.
      const second = steps[1];
      expect(firstPresence.untilTick).toBe(second?.tick);
    }
    // The second transition is a tap-out: it starts a dwell, so its presence is at.
    const second = steps[1];
    const secondPresence = second?.presence.get("C09");
    expect(directionOf(second?.readings[0])).toBe("out");
    expect(secondPresence?.kind).toBe("at");
    if (secondPresence?.kind === "at") {
      expect(secondPresence.node).toBe(second?.readings[0]?.reading.reading.station);
      const third = steps[2];
      expect(secondPresence.untilTick).toBe(third?.tick);
    }
  });

  it("carries the correct game-second timestamp on each tap", () => {
    const { steps } = stepThrough(base, 4242);
    for (const step of steps) {
      const reading = step.readings[0]?.reading.reading;
      expect(reading?.ts).toBe(step.tick * GAME_SECONDS_PER_TICK);
    }
  });
});

describe("initialRiderPresence", () => {
  it("places a fresh rider at its origin until its first tick", () => {
    const presence = initialRiderPresence("mkt", 12);
    expect(presence).toEqual({ kind: "at", node: "mkt", fromTick: 12, untilTick: 12 });
  });
});
