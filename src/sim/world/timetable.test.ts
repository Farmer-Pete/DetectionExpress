import { describe, expect, it } from "vitest";
import {
  GAME_SECONDS_PER_TICK,
  TRAIN_DWELL_TICKS,
  TRAIN_HEADWAY_MINUTES,
  TRAIN_SERVICE_SPAN_MINUTES,
} from "../../game/tuning";
import { createSchedule, minutesToTicks } from "../actors/actor";
import { createTrain } from "../actors/train";
import type { WorldEnv } from "../world-reading";
import { distanceTable } from "./distance";
import { buildTimetable, nextService, trainIdForLine } from "./timetable";
import { world } from "./world";

const timetable = buildTimetable(world);
const env: WorldEnv = { world, distances: distanceTable(world), timetable };

/** One train motion event, in the tick domain, distilled from `createTrain`'s real readings. */
interface TrainEvent {
  event: "arr" | "dep";
  station: string;
  tick: number;
}

/**
 * The REAL events a `createTrain` on `lineId` emits, driven through the scheduler and
 * mapped back to ticks. This is the independent source of truth `nextService` is
 * checked against: the train, not a second copy of the stepping math.
 */
function trainEvents(lineId: string, horizon: number): TrainEvent[] {
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

/** The next real service for a pair, read straight off the train's emitted events. */
function serviceFromEvents(
  events: readonly TrainEvent[],
  from: string,
  to: string,
  afterTick: number,
): { boardTick: number; alightTick: number } | null {
  for (let i = 0; i < events.length; i++) {
    const dep = events[i];
    if (dep === undefined || dep.event !== "dep" || dep.station !== from || dep.tick < afterTick) {
      continue;
    }
    for (let j = i + 1; j < events.length; j++) {
      const step = events[j];
      if (step === undefined) {
        break;
      }
      if (step.event === "arr" && step.station === to) {
        return { boardTick: dep.tick, alightTick: step.tick };
      }
      if (step.event === "dep" && step.station === from) {
        break;
      }
    }
  }
  return null;
}

/** The direct connection minutes on one line between two adjacent stations. */
function edgeMinutes(lineId: string, from: string, to: string): number {
  const station = world.stations.find((candidate) => candidate.id === from);
  const edge = station?.connections.find((c) => c.to === to && c.line === lineId);
  if (edge === undefined) {
    throw new Error(`no edge ${from}->${to} on ${lineId}`);
  }
  return edge.minutes;
}

describe("buildTimetable", () => {
  it("exposes one schedule per world line, in world order", () => {
    expect(timetable.lines().map((line) => line.line)).toEqual(world.lines.map((line) => line.id));
  });

  it("keeps each line's ported station order as its stops", () => {
    const red = timetable.line("red");
    expect(red.stops).toEqual(["har", "mkt", "cen", "riv", "end"]);
    expect(red.loop).toBe(false);
  });

  it("closes a loop line's stops so it repeats (Circle: cen -> jct -> cen)", () => {
    const circle = timetable.line("circle");
    expect(circle.loop).toBe(true);
    expect(circle.stops).toEqual(["cen", "jct", "cen"]);
    // Every stop is a real station on that line.
    for (const stop of circle.stops) {
      expect(world.stations.some((station) => station.id === stop)).toBe(true);
    }
  });

  it("times each hop as the connection minutes converted to ticks", () => {
    for (const schedule of timetable.lines()) {
      expect(schedule.hopTicks).toHaveLength(schedule.stops.length - 1);
      for (let i = 0; i + 1 < schedule.stops.length; i++) {
        const from = schedule.stops[i];
        const to = schedule.stops[i + 1];
        expect(from).toBeDefined();
        expect(to).toBeDefined();
        if (from === undefined || to === undefined) {
          continue;
        }
        expect(schedule.hopTicks[i]).toBe(minutesToTicks(edgeMinutes(schedule.line, from, to)));
        expect(schedule.hopTicks[i]).toBeGreaterThan(0);
      }
    }
  });

  it("dwells the tuning dwell at every platform", () => {
    for (const schedule of timetable.lines()) {
      expect(schedule.dwellTicks).toBe(TRAIN_DWELL_TICKS);
    }
  });

  it("staggers each line's launch by the headway, within the service span", () => {
    const headwayTicks = minutesToTicks(TRAIN_HEADWAY_MINUTES);
    const serviceTicks = minutesToTicks(TRAIN_SERVICE_SPAN_MINUTES);
    world.lines.forEach((line, index) => {
      const schedule = timetable.line(line.id);
      expect(schedule.startTick).toBe((index * headwayTicks) % serviceTicks);
      expect(schedule.startTick).toBeGreaterThanOrEqual(0);
      expect(schedule.startTick).toBeLessThan(serviceTicks);
    });
  });

  it("is deterministic: two builds agree field for field", () => {
    expect(buildTimetable(world).lines()).toEqual(buildTimetable(world).lines());
  });

  it("throws on an unknown line", () => {
    expect(() => timetable.line("purple")).toThrow(/unknown line/);
  });
});

describe("trainIdForLine", () => {
  it("maps each line to T1..T4 in world order", () => {
    expect(world.lines.map((line) => trainIdForLine(world, line.id))).toEqual([
      "T1",
      "T2",
      "T3",
      "T4",
    ]);
  });

  it("throws on an unknown line", () => {
    expect(() => trainIdForLine(world, "purple")).toThrow(/unknown line/);
  });
});

describe("nextService", () => {
  it("boards and alights at the train's real departure and arrival ticks", () => {
    // Drive the real Red-line train and compare, for many pairs and boarding times,
    // that nextService lands on the exact dep(from) and arr(to) the train emits.
    const events = trainEvents("red", 5000);
    const stops = timetable.line("red").stops;
    for (const from of stops) {
      for (const to of stops) {
        if (from === to) {
          continue;
        }
        for (const afterTick of [0, 5, 200, 640]) {
          const expected = serviceFromEvents(events, from, to, afterTick);
          const actual = nextService(timetable.line("red"), from, to, afterTick);
          expect(actual).toEqual(expected);
        }
      }
    }
  });

  it("rides a multi-hop trip through the intermediate dwells (har -> cen)", () => {
    const events = trainEvents("red", 2000);
    const expected = serviceFromEvents(events, "har", "cen", 0);
    const service = nextService(timetable.line("red"), "har", "cen", 0);
    expect(service).toEqual(expected);
    // The Red train departs har at tick 0 and reaches cen two hops later; the ride
    // spans the mkt dwell, so alight is strictly after board.
    expect(service?.boardTick).toBe(0);
    expect(service?.alightTick).toBeGreaterThan(service?.boardTick ?? 0);
  });

  it("waits for the correct direction: the next departure that heads toward `to`", () => {
    // After the train has passed heading away from `to`, the boarding is the later
    // pass in the right direction, matching the train's real next dep(from)/arr(to).
    const events = trainEvents("red", 5000);
    const expected = serviceFromEvents(events, "riv", "har", 300);
    const service = nextService(timetable.line("red"), "riv", "har", 300);
    expect(service).toEqual(expected);
    expect(service?.boardTick).toBeGreaterThanOrEqual(300);
  });

  it("serves a loop line in its forward ring (Circle cen <-> jct)", () => {
    const events = trainEvents("circle", 3000);
    for (const [from, to] of [
      ["cen", "jct"],
      ["jct", "cen"],
    ] as const) {
      const expected = serviceFromEvents(events, from, to, 0);
      expect(nextService(timetable.line("circle"), from, to, 0)).toEqual(expected);
    }
  });

  it("is deterministic for a pair and a boarding time", () => {
    expect(nextService(timetable.line("red"), "mkt", "end", 100)).toEqual(
      nextService(timetable.line("red"), "mkt", "end", 100),
    );
  });

  it("returns null for the same station or a station not on the line", () => {
    expect(nextService(timetable.line("red"), "cen", "cen", 0)).toBeNull();
    // Bayside is a Blue-line stop, not on the Red line.
    expect(nextService(timetable.line("red"), "har", "bay", 0)).toBeNull();
  });

  it("keeps matching the real train many cycles into a perpetual run, for every line", () => {
    // The train is periodic, so `nextService` must find a boarding at any tick, however
    // far out. For every line (Red with its end reflection, Blue, Green, the Circle
    // loop) and every ordered pair, the ticks still equal the real train's dep/arr far
    // into the run.
    for (const line of world.lines) {
      const events = trainEvents(line.id, 300000);
      const uniqueStops = [...new Set(timetable.line(line.id).stops)];
      for (const from of uniqueStops) {
        for (const to of uniqueStops) {
          if (from === to) {
            continue;
          }
          for (const afterTick of [50000, 100000, 123457, 250000]) {
            const expected = serviceFromEvents(events, from, to, afterTick);
            const actual = nextService(timetable.line(line.id), from, to, afterTick);
            expect(actual).toEqual(expected);
          }
        }
      }
    }
  });

  it("returns the real next Circle departure past the old bounded-generator expiry", () => {
    // Regression: the old fixed-leg generator expired after a few cycles and THREW
    // here (Circle departs jct every 210 ticks; the last generated one was 1125). The
    // periodic version must return the real next jct -> cen departure at 1335.
    const events = trainEvents("circle", 5000);
    const expected = serviceFromEvents(events, "jct", "cen", 1126);
    const service = nextService(timetable.line("circle"), "jct", "cen", 1126);
    expect(service).toEqual(expected);
    expect(service).not.toBeNull();
  });

  it("never throws and keeps returning a monotone service across a very long run", () => {
    const schedule = timetable.line("red");
    for (let afterTick = 0; afterTick <= 120000; afterTick += 137) {
      const service = nextService(schedule, "har", "end", afterTick);
      expect(service).not.toBeNull();
      expect(service?.boardTick).toBeGreaterThanOrEqual(afterTick);
      expect(service?.alightTick).toBeGreaterThan(service?.boardTick ?? 0);
    }
  });
});
