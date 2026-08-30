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
import { trainCycle } from "../actors/train-stepping";
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

/** The next service found for a boarding: when the train leaves `from`, when it reaches `to`. */
export interface Service {
  /** The tick the line's train departs `from`, at or after `afterTick`. The rider taps in here. */
  boardTick: number;
  /** The tick that same train arrives at `to`, having ridden through any stops between. */
  alightTick: number;
}

/**
 * The deterministic train id for a line, `T1..T4` in world-line order. Shared by the
 * run-controller (which seeds the trains) and a live rider (which names the train it
 * boards), so the rider's `onTrain` presence references the real train's `ActorView`.
 */
export function trainIdForLine(world: World, lineId: string): string {
  const index = world.lines.findIndex((line) => line.id === lineId);
  if (index < 0) {
    throw new Error(`trainIdForLine: unknown line "${lineId}".`);
  }
  return `T${index + 1}`;
}

/**
 * The next service on one line from `from` to `to` at or after `afterTick`: the tick
 * the line's single train DEPARTS `from` heading toward `to`, and the tick it ARRIVES
 * at `to`. It finds the earliest departure from `from` whose direction reaches `to`
 * before the train returns to `from`, and rides it there. The tick math is the shared
 * stepping, so the ticks equal `createTrain`'s emitted `dep`/`arr`.
 *
 * Periodic and unbounded in time. The train's motion repeats every `cycle.period` ticks,
 * so rather than simulate every leg up to a distant `afterTick` (which would eventually
 * run out and throw), it fast-forwards by whole cycles to preserve the train's phase,
 * then scans a bounded few cycles from there. It never throws for a valid service at any
 * `afterTick`, however large.
 *
 * Returns null only when the line has no direct service for the pair (an equal stop, or
 * a station not on the line). On a shared line a next pass always exists, so a real
 * boarding never returns null.
 */
export function nextService(
  schedule: LineTimetable,
  from: string,
  to: string,
  afterTick: number,
): Service | null {
  if (from === to || !schedule.stops.includes(from) || !schedule.stops.includes(to)) {
    return null;
  }

  const cycle = trainCycle(schedule);
  const start = schedule.startTick;
  // Fast-forward whole cycles so cycle `k0` starts at or before `afterTick`, preserving
  // the train's phase. Materialize a few consecutive cycles from there: the earliest
  // boarding at or after `afterTick` lies in cycle k0 or k0+1, and its ride to `to`
  // completes within the following cycles. Four cycles is comfortably enough.
  const k0 = afterTick <= start ? 0 : Math.floor((afterTick - start) / cycle.period);
  const legs: { fromStation: string; toStation: string; depTick: number; arrTick: number }[] = [];
  for (let k = k0; k <= k0 + 3; k++) {
    const base = start + k * cycle.period;
    for (const leg of cycle.legs) {
      legs.push({
        fromStation: leg.fromStation,
        toStation: leg.toStation,
        depTick: base + leg.depOffset,
        arrTick: base + leg.arrOffset,
      });
    }
  }

  for (let boarding = 0; boarding < legs.length; boarding++) {
    const departure = legs[boarding];
    if (
      departure === undefined ||
      departure.fromStation !== from ||
      departure.depTick < afterTick
    ) {
      continue;
    }
    // Ride forward from this departure until the train reaches `to`. If it returns to
    // `from` first, this departure was heading the wrong way; try the next one.
    for (let leg = boarding; leg < legs.length; leg++) {
      const current = legs[leg];
      if (current === undefined) {
        break;
      }
      // A fresh departure from `from` ends this boarding's ride: its arrival belongs to
      // that later departure, so break before crediting it to this one.
      if (leg > boarding && current.fromStation === from) {
        break;
      }
      if (current.toStation === to) {
        return { boardTick: departure.depTick, alightTick: current.arrTick };
      }
    }
  }

  // A shared-line pair is always served, so this is unreachable for a real boarding; a
  // defensive null (the caller's fallback), never a throw that could stop the run.
  return null;
}
