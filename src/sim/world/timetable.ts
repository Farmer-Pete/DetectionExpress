/**
 * The train timetable: a pure, deterministic schedule derived from the world's lines,
 * their station order, and the connection minutes between adjacent stops. One train
 * rides each line stop to stop, so per line the timetable exposes the ordered stops,
 * the per-hop travel time in ticks, the platform dwell in ticks, and a launch phase.
 *
 * A loop line's stops already return to the start (the Circle closes cen -> jct ->
 * cen), so a train repeats it instead of ping-ponging. Travel time is the connection
 * minutes run through `minutesToTicks`; the headway phases the four launches so they do
 * not leave in lockstep; the service span bounds that phase. No RNG, no wall clock, no
 * React (ADR-0007, ARCHITECTURE rule 8). Computed, never stored (see #87 migrations).
 */
import {
  TRAIN_DWELL_TICKS,
  TRAIN_HEADWAY_MINUTES,
  TRAIN_SERVICE_SPAN_MINUTES,
} from "../../game/tuning";
import { minutesToTicks } from "../actors/actor";
import type { World } from "./world";

/** One line's ride plan: enough for a single train to run it end to end. */
export interface LineTimetable {
  /** The line id, e.g. `"red"`. */
  readonly line: string;
  /** True when the line loops; its stops already return to the start. */
  readonly loop: boolean;
  /** The ordered stops along the line, from `world.json`'s station order. */
  readonly stops: readonly string[];
  /** The platform dwell in whole ticks, uniform across stops. */
  readonly dwellTicks: number;
  /** Travel time in ticks for the hop leaving `stops[i]`; length is `stops.length - 1`. */
  readonly hopTicks: readonly number[];
  /** The first tick this line's train departs its origin, phased by the headway. */
  readonly startTick: number;
}

/** The whole timetable: one schedule per line, read by id or in world order. */
export interface Timetable {
  /** The schedule for one line. Throws on an unknown line. */
  line(lineId: string): LineTimetable;
  /** Every line's schedule, in `world.json` order. */
  lines(): readonly LineTimetable[];
}

/** The direct connection minutes on one line between two adjacent stations. */
function edgeMinutes(world: World, lineId: string, from: string, to: string): number {
  const station = world.stations.find((candidate) => candidate.id === from);
  const edge = station?.connections.find((c) => c.to === to && c.line === lineId);
  if (edge === undefined) {
    throw new Error(`timetable: line "${lineId}" has no edge "${from}" -> "${to}".`);
  }
  return edge.minutes;
}

/**
 * Build the deterministic timetable. Each line's hops are its connection minutes in
 * ticks; the dwell is the tuning dwell; the launch phase is the line's index times the
 * headway, wrapped within the service span so it can never fall past end of service.
 */
export function buildTimetable(world: World): Timetable {
  const headwayTicks = minutesToTicks(TRAIN_HEADWAY_MINUTES);
  const serviceTicks = minutesToTicks(TRAIN_SERVICE_SPAN_MINUTES);

  const schedules = world.lines.map((line, index): LineTimetable => {
    const stops = line.stations;
    const hopTicks: number[] = [];
    for (let i = 0; i + 1 < stops.length; i++) {
      const from = stops[i];
      const to = stops[i + 1];
      if (from === undefined || to === undefined) {
        continue;
      }
      hopTicks.push(minutesToTicks(edgeMinutes(world, line.id, from, to)));
    }
    return {
      line: line.id,
      loop: line.loop,
      stops,
      dwellTicks: TRAIN_DWELL_TICKS,
      hopTicks,
      startTick: (index * headwayTicks) % serviceTicks,
    };
  });

  const byId = new Map(schedules.map((schedule) => [schedule.line, schedule]));

  return {
    line: (lineId) => {
      const schedule = byId.get(lineId);
      if (schedule === undefined) {
        throw new Error(`timetable: unknown line "${lineId}".`);
      }
      return schedule;
    },
    lines: () => schedules,
  };
}
