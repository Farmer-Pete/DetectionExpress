import { describe, expect, it } from "vitest";
import {
  TRAIN_DWELL_TICKS,
  TRAIN_HEADWAY_MINUTES,
  TRAIN_SERVICE_SPAN_MINUTES,
} from "../../game/tuning";
import { minutesToTicks } from "../actors/actor";
import { buildTimetable } from "./timetable";
import { world } from "./world";

const timetable = buildTimetable(world);

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
