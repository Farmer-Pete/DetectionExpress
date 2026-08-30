import { describe, expect, it } from "vitest";
import { GAME_SECONDS_PER_TICK } from "../../game/tuning";
import { distanceTable } from "../world/distance";
import { buildTimetable, trainIdForLine } from "../world/timetable";
import { world } from "../world/world";
import type { WorldEnv, WorldReading } from "../world-reading";
import { createSchedule } from "./actor";
import type { RiderTripConfig } from "./rider-core";
import { createTrain } from "./train";
import { createWorldRider, initialRiderPresence } from "./world-rider";

const distances = distanceTable(world);
const timetable = buildTimetable(world);
const env: WorldEnv = { world, distances, timetable };

/** The tap direction of a reading, narrowed off the discriminated union. */
function directionOf(timed: { reading: WorldReading } | undefined): "in" | "out" | undefined {
  if (timed === undefined || timed.reading.sensor !== "fare-gate") {
    return undefined;
  }
  return timed.reading.reading.direction;
}

const HORIZON = 1000;

const base: RiderTripConfig = {
  card: "C09",
  origin: "cen",
  balance: 2000,
  window: { startTick: 0, endTick: HORIZON - 400 },
  fare: { base: 10, perMinute: 5 },
  jitterTicks: { min: 0, max: 4 },
  dwellTicks: { min: 2, max: 6 },
};

interface Step {
  tick: number;
  readings: { reading: WorldReading; actorId: string }[];
  presence: ReturnType<ReturnType<typeof createSchedule>["advanceTo"]>["presences"];
}

/** Step one live rider one tick at a time to the horizon, collecting each non-empty step. */
function stepThrough(config: RiderTripConfig, runSeed: number): Step[] {
  const schedule = createSchedule({ actors: [createWorldRider(config)], env, runSeed });
  const steps: Step[] = [];
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
  return steps;
}

/** The real (event, station, tick) list a `createTrain` on `lineId` emits. */
function trainEvents(lineId: string, horizon: number) {
  const startTick = timetable.line(lineId).startTick;
  const schedule = createSchedule({
    actors: [createTrain({ id: "TX", line: lineId, startTick })],
    env,
    runSeed: 1,
  });
  return schedule.advanceTo(horizon).readings.map((timed) => {
    const reading = timed.reading;
    if (reading.sensor !== "train-tracker") {
      throw new Error(`expected a train-tracker reading, got "${reading.sensor}".`);
    }
    return {
      event: reading.reading.event,
      station: reading.reading.station,
      tick: reading.reading.ts / GAME_SECONDS_PER_TICK,
    };
  });
}

describe("createWorldRider coupled to trains", () => {
  it("waits at its origin, then boards the line's real train and alights at its real arrival", () => {
    const steps = stepThrough(base, 4242);

    // The first step is the wait: the rider stands `at` its origin with no tap yet,
    // until the tick its train departs.
    const wait = steps[0];
    expect(wait?.readings).toHaveLength(0);
    const waitPresence = wait?.presence.get("C09");
    expect(waitPresence?.kind).toBe("at");
    const origin = base.origin;
    if (waitPresence?.kind === "at") {
      expect(waitPresence.node).toBe(origin);
    }

    // The next step is the boarding tap-in: it rides `onTrain` until the arrival.
    const board = steps[1];
    const boardReading = board?.readings[0]?.reading;
    expect(directionOf(board?.readings[0])).toBe("in");
    if (boardReading?.sensor !== "fare-gate") {
      throw new Error("expected a fare-gate tap-in");
    }
    const line = boardReading.reading.line;
    expect(boardReading.reading.station).toBe(origin);
    const boardPresence = board?.presence.get("C09");
    expect(boardPresence?.kind).toBe("onTrain");
    if (boardPresence?.kind !== "onTrain") {
      throw new Error("expected an onTrain presence while riding");
    }
    // The wait's `at` presence ends exactly when the ride begins.
    if (waitPresence?.kind === "at") {
      expect(waitPresence.untilTick).toBe(board?.tick);
    }
    const boardTick = board?.tick ?? -1;
    const alightTick = boardPresence.untilTick;
    expect(boardPresence.fromTick).toBe(boardTick);

    // The tap-out: the rider alights at the destination when the ride ends.
    const alight = steps[2];
    expect(alight?.tick).toBe(alightTick);
    expect(directionOf(alight?.readings[0])).toBe("out");
    const alightReading = alight?.readings[0]?.reading;
    if (alightReading?.sensor !== "fare-gate") {
      throw new Error("expected a fare-gate tap-out");
    }
    const dest = alightReading.reading.station;

    // The coupling is real: the boarded train is the line's train, and it truly
    // departs the origin at boardTick and arrives the destination at alightTick.
    expect(boardPresence.train).toBe(trainIdForLine(world, line));
    const events = trainEvents(line, HORIZON);
    expect(events).toContainEqual({ event: "dep", station: origin, tick: boardTick });
    expect(events).toContainEqual({ event: "arr", station: dest, tick: alightTick });
  });

  it("taps in then out, alternating, and every reading is a fare-gate reading", () => {
    const schedule = createSchedule({ actors: [createWorldRider(base)], env, runSeed: 4242 });
    const readings = schedule.advanceTo(HORIZON).readings;
    expect(readings.length).toBeGreaterThan(0);
    readings.forEach((timed, index) => {
      expect(timed.reading.sensor).toBe("fare-gate");
      expect(directionOf(timed)).toBe(index % 2 === 0 ? "in" : "out");
    });
  });

  it("charges the fare on tap-in and leaves the balance unchanged on tap-out", () => {
    const steps = stepThrough(base, 4242);
    const tapIn = steps[1]?.readings[0]?.reading;
    const tapOut = steps[2]?.readings[0]?.reading;
    if (tapIn?.sensor !== "fare-gate" || tapOut?.sensor !== "fare-gate") {
      throw new Error("expected fare-gate taps");
    }
    // The core charges the fare on entry; the balance the two taps carry is the same
    // post-fare figure, and it never rises within a trip.
    expect(tapIn.reading.balance).toBeLessThan(base.balance);
    expect(tapOut.reading.balance).toBe(tapIn.reading.balance);
  });

  it("carries the game-second timestamp on each tap", () => {
    for (const step of stepThrough(base, 4242)) {
      const reading = step.readings[0]?.reading;
      if (reading?.sensor === "fare-gate") {
        expect(reading.reading.ts).toBe(step.tick * GAME_SECONDS_PER_TICK);
      }
    }
  });

  it("every onboard presence names a real train arriving at the rider's stop", () => {
    // Over a whole run, each `onTrain` leg must be a real service: the named train
    // departs the boarding station and arrives the alighting station on the timetable.
    const steps = stepThrough(base, 4242);
    for (let i = 0; i < steps.length; i++) {
      const presence = steps[i]?.presence.get("C09");
      if (presence?.kind !== "onTrain") {
        continue;
      }
      const tapIn = steps[i]?.readings[0]?.reading;
      const tapOut = steps[i + 1]?.readings[0]?.reading;
      if (tapIn?.sensor !== "fare-gate" || tapOut?.sensor !== "fare-gate") {
        throw new Error("an onTrain leg must sit between a tap-in and a tap-out");
      }
      const events = trainEvents(tapIn.reading.line, HORIZON);
      expect(presence.train).toBe(trainIdForLine(world, tapIn.reading.line));
      expect(events).toContainEqual({
        event: "dep",
        station: tapIn.reading.station,
        tick: steps[i]?.tick,
      });
      expect(events).toContainEqual({
        event: "arr",
        station: tapOut.reading.station,
        tick: presence.untilTick,
      });
    }
  });

  it("rides train after train across a very long run without throwing", () => {
    // A rider admitted with a far-future window keeps calling `nextService` at large
    // ticks. The coupling must stay live for the whole window, never throwing (which
    // would stop the world loop), and keep emitting real taps.
    const longConfig: RiderTripConfig = {
      ...base,
      origin: "har",
      window: { startTick: 0, endTick: 120000 },
    };
    const schedule = createSchedule({ actors: [createWorldRider(longConfig)], env, runSeed: 7 });
    let taps = 0;
    expect(() => {
      for (let tick = 0; tick < 121000; tick++) {
        taps += schedule.advanceTo(tick + 1).readings.length;
      }
    }).not.toThrow();
    // Many trips over a 120k-tick window, each a tap-in and a tap-out.
    expect(taps).toBeGreaterThan(50);
  });

  it("is deterministic: a seed reproduces the same readings and presences", () => {
    const run = () =>
      stepThrough(base, 20260830).map((step) => ({
        tick: step.tick,
        readings: step.readings.map((r) => r.reading),
        presence: step.presence.get("C09"),
      }));
    expect(run()).toEqual(run());
  });
});

describe("initialRiderPresence", () => {
  it("places a fresh rider at its origin until its first tick", () => {
    const presence = initialRiderPresence("mkt", 12);
    expect(presence).toEqual({ kind: "at", node: "mkt", fromTick: 12, untilTick: 12 });
  });
});
