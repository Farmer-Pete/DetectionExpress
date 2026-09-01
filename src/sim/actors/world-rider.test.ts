import { randomLcg } from "d3-random";
import { describe, expect, it } from "vitest";
import {
  GAME_SECONDS_PER_TICK,
  RIDER_GOHOME_DWELL_TICKS,
  TRAIN_DWELL_TICKS,
  TVM_TOPUP_AMOUNT,
} from "../../game/tuning";
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

    // The coupling is real: the boarded train is the line's real train, and it truly
    // arrives the destination at alightTick. The tap-in itself lands DURING that
    // train's dwell at the origin -- strictly before its real departure, never at or
    // after it -- so the rider boards a stopped train, not one already leaving.
    expect(boardPresence.train).toBe(trainIdForLine(world, line));
    const events = trainEvents(line, HORIZON);
    const departure = events.find(
      (event) => event.event === "dep" && event.station === origin && event.tick > boardTick,
    );
    expect(departure).toBeDefined();
    if (departure === undefined) {
      throw new Error("expected a real departure from the origin after the board tick");
    }
    expect(departure.tick - boardTick).toBeLessThanOrEqual(TRAIN_DWELL_TICKS);
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
      // The tap-in tick is the boarding-window start: strictly before the boarded
      // train's real departure, and within its dwell -- boarding a stopped train, not
      // one already moving.
      const boardTick = steps[i]?.tick ?? -1;
      const departure = events.find(
        (event) =>
          event.event === "dep" &&
          event.station === tapIn.reading.station &&
          event.tick > boardTick,
      );
      expect(departure).toBeDefined();
      if (departure === undefined) {
        throw new Error("expected a real departure after the board tick");
      }
      expect(departure.tick - boardTick).toBeLessThanOrEqual(TRAIN_DWELL_TICKS);
      expect(events).toContainEqual({
        event: "arr",
        station: tapOut.reading.station,
        tick: presence.untilTick,
      });
    }
  });

  it("takes exactly one trip across a very long window, then stays dormant, without throwing", () => {
    // A rider admitted with a far-future window still makes only its one trip (GH116):
    // it goes dormant long before the window closes. The coupling must stay stable for
    // the whole window, never throwing (which would stop the world loop).
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
    // Exactly one trip over the whole window: one tap-in and one tap-out, never more.
    expect(taps).toBe(2);
  });

  it("takes exactly one trip, dwells at its destination for the go-home window, then goes dormant and never taps in again", () => {
    // Drive the actor directly (not through the schedule) so the exact rng draws and
    // the final "dormant" tick are both observable, the same way the TVM tests below
    // drive it. This proves the whole one-trip lifecycle: plan -> ride -> exit ->
    // leaving -> dormant, with no second trip.
    const rng = randomLcg(4242);
    const actor = createWorldRider(base);
    const readings: WorldReading[] = [];
    const presences: {
      tick: number;
      presence: NonNullable<ReturnType<typeof actor.act>["presence"]>;
    }[] = [];
    let next = actor.start({ rng });
    let guard = 0;
    while (next !== "dormant" && guard < 2000) {
      const tick = next;
      const result = actor.act({ env, rng, tick });
      readings.push(...result.readings);
      if (result.presence !== undefined) {
        presences.push({ tick, presence: result.presence });
      }
      next = result.nextTick;
      guard += 1;
    }

    const tapIns = readings.filter((reading) => tapDir(reading) === "in");
    const tapOuts = readings.filter((reading) => tapDir(reading) === "out");
    expect(tapIns).toHaveLength(1);
    expect(tapOuts).toHaveLength(1);
    const inIndex = tapIns[0] ? readings.indexOf(tapIns[0]) : -1;
    const outIndex = tapOuts[0] ? readings.indexOf(tapOuts[0]) : -1;
    expect(inIndex).toBeGreaterThanOrEqual(0);
    expect(inIndex).toBeLessThan(outIndex);

    // The tap-out's act also reports the destination `at` presence -- the last one
    // recorded, since the final "leaving" act reports no presence -- and it spans
    // exactly the go-home dwell, so the alight animation has room to finish.
    const destPresence = presences.at(-1)?.presence;
    expect(destPresence?.kind).toBe("at");
    if (destPresence?.kind === "at") {
      expect(destPresence.untilTick).toBe(destPresence.fromTick + RIDER_GOHOME_DWELL_TICKS);
    }

    // The actor ends dormant, not another planning cycle: no second tap-in ever fires.
    expect(next).toBe("dormant");
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

/**
 * Drive one actor directly to dormancy through a SPY rng, recording every value it
 * draws and every reading it emits. Driving the actor (not the schedule) lets the test
 * see the exact rng stream, so it can prove the funded path draws no extra value.
 */
function drawsAndReadings(actor: ReturnType<typeof createWorldRider>, seed: number) {
  const draws: number[] = [];
  const base = randomLcg(seed);
  const rng = (): number => {
    const value = base();
    draws.push(value);
    return value;
  };
  const readings: WorldReading[] = [];
  let next = actor.start({ rng });
  let guard = 0;
  while (next !== "dormant" && guard < 200000) {
    const tick = next;
    const result = actor.act({ env, rng, tick });
    readings.push(...result.readings);
    next = result.nextTick;
    guard += 1;
  }
  return { draws, readings };
}

/** The direction of a fare-gate reading, or undefined for any other sensor. */
function tapDir(reading: WorldReading): "in" | "out" | undefined {
  return reading.sensor === "fare-gate" ? reading.reading.direction : undefined;
}

describe("createWorldRider TVM top-up (M4)", () => {
  it("is provably additive: a funded rider draws no extra rng and emits no tvm reading", () => {
    // A funded rider (a balance far above a whole window of fares) never runs low, so
    // the top-up transition can never fire. Its rng budget is then exactly the shared
    // core's: one dwell draw at start, then two draws per tap-in (destination + jitter)
    // and one per tap-out (dwell). Any top-up would insert a tvm reading AND an extra
    // destination draw, so matching both over many seeds proves the path adds nothing.
    const funded: RiderTripConfig = { ...base, origin: "har", balance: 1_000_000 };
    for (const seed of [1, 2, 7, 42, 4242, 20260830, 999, 12345]) {
      const { draws, readings } = drawsAndReadings(createWorldRider(funded), seed);
      const tapIns = readings.filter((reading) => tapDir(reading) === "in").length;
      const tapOuts = readings.filter((reading) => tapDir(reading) === "out").length;
      expect(readings.some((reading) => reading.sensor === "tvm")).toBe(false);
      expect(tapIns).toBeGreaterThan(0);
      expect(draws.length).toBe(1 + 2 * tapIns + tapOuts);
    }
  });

  it("tops up at the origin TVM when it cannot afford its first trip, then takes its one trip", () => {
    // A balance below every fare from the origin (the cheapest fare is `fare.base`,
    // 10) makes the very first trip unaffordable, whatever destination the core would
    // draw. Instead of going dormant the rider tops up at its station's TVM, then
    // takes its single trip (GH116: one trip, not a second ride after the top-up).
    const unaffordable: RiderTripConfig = {
      ...base,
      origin: "cen",
      balance: 5,
      window: { startTick: 0, endTick: 800 },
    };
    const schedule = createSchedule({
      actors: [createWorldRider(unaffordable)],
      env,
      runSeed: 4242,
    });
    const timed = schedule.advanceTo(1000).readings;

    const topups = timed.filter((entry) => entry.reading.sensor === "tvm");
    expect(topups).toHaveLength(1);

    const topup = topups[0]?.reading;
    if (topup?.sensor !== "tvm") {
      throw new Error("expected a tvm reading");
    }
    expect(topup.reading.kind).toBe("topup");
    expect(topup.reading.card).toBe(unaffordable.card);
    expect(topup.reading.machine).toBe("V1");
    expect(topup.reading.amount).toBe(TVM_TOPUP_AMOUNT);
    expect(Number.isInteger(topup.reading.amount)).toBe(true);
    expect(topup.reading.station).toBe(unaffordable.origin);
    expect(world.stations.some((station) => station.id === topup.reading.station)).toBe(true);

    // The top-up fires on the low-balance path, not at the window's end: its tick is
    // well within the active window.
    const topupTick = topups[0]?.tick ?? Number.NaN;
    expect(topupTick).toBeLessThan(unaffordable.window.endTick);

    // It lifts the balance so the trip becomes affordable: exactly one tap-in follows
    // the top-up, and exactly one tap-out follows that -- the rider's single trip, no
    // second ride.
    const tapIns = timed.filter((entry) => tapDir(entry.reading) === "in");
    const tapOuts = timed.filter((entry) => tapDir(entry.reading) === "out");
    expect(tapIns).toHaveLength(1);
    expect(tapOuts).toHaveLength(1);
    expect(tapIns[0]?.tick ?? Number.NaN).toBeGreaterThan(topupTick);
    expect(tapOuts[0]?.tick ?? Number.NaN).toBeGreaterThan(tapIns[0]?.tick ?? Number.NaN);
  });
});
