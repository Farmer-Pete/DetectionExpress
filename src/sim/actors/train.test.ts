import { describe, expect, it } from "vitest";
import { GAME_SECONDS_PER_TICK } from "../../game/tuning";
import { distanceTable } from "../world/distance";
import { metroLines } from "../world/layout";
import { buildTimetable } from "../world/timetable";
import { world } from "../world/world";
import type { WorldEnv, WorldReading } from "../world-reading";
import { createSchedule } from "./actor";
import { createTrain, initialTrainPresence, type TrainConfig } from "./train";

const env: WorldEnv = {
  world,
  distances: distanceTable(world),
  timetable: buildTimetable(world),
};

/** A train reading's payload, narrowed off the discriminated union. */
function trainOf(reading: WorldReading) {
  if (reading.sensor !== "train-tracker") {
    throw new Error(`expected a train-tracker reading, got "${reading.sensor}".`);
  }
  return reading.reading;
}

/** Run one train to a horizon and list its readings in emission order. */
function readingsTo(config: TrainConfig, horizon: number) {
  const schedule = createSchedule({ actors: [createTrain(config)], env, runSeed: 1 });
  return schedule.advanceTo(horizon).readings.map((timed) => trainOf(timed.reading));
}

/** Step one train one tick at a time, collecting each non-empty step. */
function stepThrough(config: TrainConfig, horizon: number) {
  const schedule = createSchedule({ actors: [createTrain(config)], env, runSeed: 1 });
  const steps: {
    tick: number;
    event: "arr" | "dep";
    station: string;
    ts: number;
    presence: ReturnType<typeof schedule.advanceTo>["presences"];
  }[] = [];
  for (let tick = 0; tick < horizon; tick++) {
    const step = schedule.advanceTo(tick + 1);
    const reading = step.readings[0];
    if (reading !== undefined) {
      const payload = trainOf(reading.reading);
      steps.push({
        tick,
        event: payload.event,
        station: payload.station,
        ts: payload.ts,
        presence: step.presences,
      });
    }
  }
  return steps;
}

const RED: TrainConfig = { id: "T1", line: "red", startTick: 0 };
const CIRCLE: TrainConfig = { id: "T4", line: "circle", startTick: 0 };

describe("createTrain", () => {
  it("rides its line stop to stop, ping-ponging at the ends, arr then dep with a track", () => {
    // Worked from the ported Red order [har,mkt,cen,riv,end], connection minutes
    // 3,2,3,4, minutesToTicks scaling (30 ticks/min), and a 15-tick dwell. Departs the
    // origin, arrives each next stop, dwells, departs; reverses at World's End.
    const readings = readingsTo(RED, 500);
    const seq = readings.map((r) => ({
      event: r.event,
      station: r.station,
      track: r.track,
      ts: r.ts,
    }));
    expect(seq).toEqual([
      { event: "dep", station: "har", track: "red:har-mkt", ts: 0 },
      { event: "arr", station: "mkt", track: "red:har-mkt", ts: 180 },
      { event: "dep", station: "mkt", track: "red:cen-mkt", ts: 210 },
      { event: "arr", station: "cen", track: "red:cen-mkt", ts: 330 },
      { event: "dep", station: "cen", track: "red:cen-riv", ts: 360 },
      { event: "arr", station: "riv", track: "red:cen-riv", ts: 540 },
      { event: "dep", station: "riv", track: "red:end-riv", ts: 570 },
      { event: "arr", station: "end", track: "red:end-riv", ts: 810 },
      { event: "dep", station: "end", track: "red:end-riv", ts: 840 },
    ]);
  });

  it("carries the train id and line on every reading", () => {
    for (const reading of readingsTo(RED, 500)) {
      expect(reading.train).toBe("T1");
      expect(reading.line).toBe("red");
    }
  });

  it("stamps ts in the game-second domain", () => {
    for (const step of stepThrough(RED, 200)) {
      expect(step.ts).toBe(step.tick * GAME_SECONDS_PER_TICK);
    }
  });

  it("repeats a loop line instead of ping-ponging (Circle cen <-> jct)", () => {
    const stations = readingsTo(CIRCLE, 600).map((r) => r.station);
    // Every stop is on the loop; the train shuttles cen and jct forever.
    for (const station of stations) {
      expect(["cen", "jct"]).toContain(station);
    }
    // The visited order repeats: dep cen, arr jct, dep jct, arr cen, dep cen, ...
    expect(stations.slice(0, 6)).toEqual(["cen", "jct", "jct", "cen", "cen", "jct"]);
  });

  it("moves between adjacent stations while running and rests at a stop while dwelling", () => {
    const steps = stepThrough(RED, 300);
    // The first transition departs the origin, so its presence is moving har -> mkt.
    const first = steps[0];
    const firstPresence = first?.presence.get("T1");
    expect(first?.event).toBe("dep");
    expect(firstPresence?.kind).toBe("moving");
    if (firstPresence?.kind === "moving") {
      expect(firstPresence.from).toBe("har");
      expect(firstPresence.to).toBe("mkt");
      expect(firstPresence.line).toBe("red");
      expect(firstPresence.fromTick).toBe(first?.tick);
      // The moving presence ends at the arrival tick, which is the next step's tick.
      expect(firstPresence.untilTick).toBe(steps[1]?.tick);
    }
    // The second transition arrives at mkt and begins a dwell, so its presence is at.
    const second = steps[1];
    const secondPresence = second?.presence.get("T1");
    expect(second?.event).toBe("arr");
    expect(secondPresence?.kind).toBe("at");
    if (secondPresence?.kind === "at") {
      expect(secondPresence.node).toBe("mkt");
      expect(secondPresence.fromTick).toBe(second?.tick);
      expect(secondPresence.untilTick).toBe(steps[2]?.tick);
    }
  });

  it("starts at its origin (the line's first polyline point) until its first departure", () => {
    expect(initialTrainPresence("har", 60, "red")).toEqual({
      kind: "at",
      node: "har",
      fromTick: 0,
      untilTick: 60,
      rail: { line: "red", from: 0, to: 0 },
    });
  });

  it("rails each Circle hop to its own polyline segment (jct -> cen is not the opening cen)", () => {
    // The Circle polyline is cen(0) -> jct(1) -> cen(2); points 0 and 2 are Central on
    // opposite offset tracks, so a (line, station) lookup would collapse them. The rail
    // metadata must send the cen -> jct hop down segment 0 and the jct -> cen hop down
    // segment 1, so the loop follows its true path instead of retracing the outbound leg.
    const circleLine = metroLines(world).find((line) => line.id === "circle");
    const points = circleLine?.points ?? [];
    expect(points).toHaveLength(3);
    // The two Central endpoints are distinct offset points, which is why the fix matters.
    expect(points[0]).not.toEqual(points[2]);

    const moving = stepThrough(CIRCLE, 400)
      .filter((step) => step.event === "dep")
      .map((step) => step.presence.get("T4"))
      .filter((presence) => presence?.kind === "moving");

    const hop1 = moving[0];
    const hop2 = moving[1];
    // cen -> jct rides segment 0 (points 0 -> 1).
    expect(hop1?.kind === "moving" ? hop1.rail : undefined).toEqual({
      line: "circle",
      from: 0,
      to: 1,
    });
    // jct -> cen rides segment 1 (points 1 -> 2), NOT back to the opening point 0.
    expect(hop2?.kind === "moving" ? hop2.rail : undefined).toEqual({
      line: "circle",
      from: 1,
      to: 2,
    });
  });

  it("keeps a dwelling train on the arrival end of the hop it just rode (no snap)", () => {
    // A moving train ends on its rail's `to` point; the following dwell must rest on that
    // same point, so the glyph does not jump to the raw station center when it stops.
    const steps = stepThrough(RED, 300);
    const departPresence = steps[0]?.presence.get("T1");
    const arrivePresence = steps[1]?.presence.get("T1");
    const movingTo = departPresence?.kind === "moving" ? departPresence.rail?.to : undefined;
    const dwellRail = arrivePresence?.kind === "at" ? arrivePresence.rail : undefined;
    expect(movingTo).toBeDefined();
    expect(dwellRail?.to).toBe(movingTo);
    expect(dwellRail?.line).toBe("red");
  });

  it("first departs at its configured start tick", () => {
    const readings = readingsTo({ id: "T1", line: "red", startTick: 40 }, 500);
    // The staggered launch shifts every tick by 40, so the origin departure lands there.
    expect(readings[0]?.ts).toBe(40 * GAME_SECONDS_PER_TICK);
  });
});
