/**
 * The train's ping-pong and loop STEPPING, extracted pure so `createTrain` and the
 * timetable's `nextService` share one source of the motion. A straight line reflects
 * at either end; a loop line's stops already return to the start, so it steps forward
 * through its ring. `stepLeg` turns one departure into the leg it rides (the next
 * stop, the hop ticks, and the polyline point indices); `trainLegs` replays a whole
 * run leg by leg from the timetable's `startTick`, dwelling at each platform.
 *
 * This is the exact motion `createTrain` performs, so a rider computing a boarding off
 * `trainLegs` boards the real train, not a phantom. Pure: no RNG, no wall clock, no
 * React (ADR-0007, ARCHITECTURE rule 8). It reads only the immutable `LineTimetable`.
 */
import type { LineTimetable } from "../world/timetable";

/**
 * The next stop index and direction from `index`, and the departing segment index. A
 * loop wraps forward through its ring (its stops repeat the origin at the end); a
 * straight line reflects at either end.
 */
function nextStop(
  schedule: LineTimetable,
  index: number,
  dir: 1 | -1,
): { index: number; dir: 1 | -1; segment: number } {
  const stops = schedule.stops;
  if (schedule.loop) {
    // The stops close on the origin (stops[last] === stops[0]), so the ring has
    // `stops.length - 1` distinct positions and the train always steps forward.
    const ring = stops.length - 1;
    const next = (index + 1) % ring;
    return { index: next, dir: 1, segment: index };
  }
  let step = index + dir;
  let nextDir = dir;
  if (step < 0 || step >= stops.length) {
    nextDir = dir === 1 ? -1 : 1;
    step = index + nextDir;
  }
  return { index: step, dir: nextDir, segment: Math.min(index, step) };
}

/**
 * One leg of a train's run: it departs `fromStation` at `depTick` and arrives at the
 * adjacent `toStation` at `arrTick`, riding the polyline segment `fromPoint -> toPoint`.
 * `toIndex`/`dir` carry the FSM state the next leg continues from.
 */
export interface TrainLeg {
  fromIndex: number;
  toIndex: number;
  fromStation: string;
  toStation: string;
  dir: 1 | -1;
  /** The polyline point index the leg leaves (the segment's near end). */
  fromPoint: number;
  /** The polyline point index the leg reaches (the segment's far end). */
  toPoint: number;
  depTick: number;
  arrTick: number;
}

/**
 * The leg a train departing `index` on `dir` at `depTick` rides: its next stop, its
 * hop in ticks, and the polyline points it travels. A straight line's stop index IS
 * its point index; a loop repeats a station id, so the far point is the segment's own
 * `segment + 1`, not the wrapped station index (which would retrace the outbound leg).
 */
export function stepLeg(
  schedule: LineTimetable,
  index: number,
  dir: 1 | -1,
  depTick: number,
): TrainLeg {
  const stops = schedule.stops;
  const step = nextStop(schedule, index, dir);
  const fromStation = stops[index];
  const toStation = stops[step.index];
  const hop = schedule.hopTicks[step.segment];
  if (fromStation === undefined || toStation === undefined || hop === undefined) {
    throw new Error(`train stepping: bad hop on line "${schedule.line}".`);
  }
  const fromPoint = index;
  const toPoint = schedule.loop ? step.segment + 1 : step.index;
  return {
    fromIndex: index,
    toIndex: step.index,
    fromStation,
    toStation,
    dir: step.dir,
    fromPoint,
    toPoint,
    depTick,
    arrTick: depTick + hop,
  };
}

/**
 * Replay the line's single train leg by leg from `startTick`, dwelling `dwellTicks` at
 * each platform between an arrival and the next departure. Infinite: the caller stops
 * it once it has what it needs (a service exists within one full cycle). The tick a
 * leg departs and arrives equals the train actor's real `dep`/`arr` ticks.
 */
function* trainLegs(schedule: LineTimetable): Generator<TrainLeg> {
  let index = 0;
  let dir: 1 | -1 = 1;
  let depTick = schedule.startTick;
  for (;;) {
    const leg = stepLeg(schedule, index, dir, depTick);
    yield leg;
    index = leg.toIndex;
    dir = leg.dir;
    depTick = leg.arrTick + schedule.dwellTicks;
  }
}

/** One leg's shape within a cycle: its stations and its tick offsets from the cycle start. */
interface CycleLeg {
  fromStation: string;
  toStation: string;
  /** The leg's departure tick minus the cycle's start tick. */
  depOffset: number;
  /** The leg's arrival tick minus the cycle's start tick. */
  arrOffset: number;
}

/** The train's motion is periodic: one full cycle repeats forever, every `period` ticks. */
export interface TrainCycle {
  /** Ticks for one full ping-pong (or loop ring), so cycle k departs at `startTick + k*period`. */
  period: number;
  /** The legs of one cycle, in order, with ticks relative to the cycle's start. */
  legs: readonly CycleLeg[];
}

/**
 * The one repeating cycle of a line's train, so a service arbitrarily far in the future
 * is found by phase, not by simulating every leg to it. A straight line returns to its
 * origin heading forward after a full ping-pong; a loop after one ring. The cycle
 * boundary is the next departure from index 0 (a terminal reflection, or the loop
 * origin), and its offset from the start is the period.
 */
export function trainCycle(schedule: LineTimetable): TrainCycle {
  const legs: CycleLeg[] = [];
  let seenFirst = false;
  for (const leg of trainLegs(schedule)) {
    if (leg.fromIndex === 0 && seenFirst) {
      return { period: leg.depTick - schedule.startTick, legs };
    }
    seenFirst = true;
    legs.push({
      fromStation: leg.fromStation,
      toStation: leg.toStation,
      depOffset: leg.depTick - schedule.startTick,
      arrOffset: leg.arrTick - schedule.startTick,
    });
  }
  // `trainLegs` is infinite and index 0 always recurs, so this is unreachable.
  throw new Error(`trainCycle: line "${schedule.line}" never closed its cycle.`);
}
