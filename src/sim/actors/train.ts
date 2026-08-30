/**
 * The metro train: a persistent `Actor<WorldReading, WorldEnv>` that rides ONE line
 * on the timetable, stop to stop, dwelling at each platform and emitting `train-tracker`
 * readings. It departs its origin (`dep`), runs a hop, arrives at the next stop (`arr`),
 * dwells, and departs again. A straight line ping-pongs at its ends; a loop line's stops
 * already return to the start, so it repeats instead.
 *
 * It is a small typed FSM in the world-rider adapter style: the closure holds the ride
 * state (the pending action, the stop index, the direction); the scheduler owns the rng
 * and the next tick. It reads the shared `env.timetable` for its line's stops, hops, and
 * dwell (ADR-0007: actors read the immutable env, never a baked-in copy). Its `presence`
 * is `moving` from the current stop to the next during a hop and `at` the stop while it
 * dwells. No RNG, no wall clock, no React (ARCHITECTURE rule 8).
 */
import { GAME_SECONDS_PER_TICK } from "../../game/tuning";
import type { Presence } from "../world/presence";
import type { WorldEnv, WorldReading } from "../world-reading";
import type { Actor } from "./actor";
import { stepLeg } from "./train-stepping";

/** One train's configuration: which line it rides and its first departure tick. */
export interface TrainConfig {
  /** The train id, e.g. `"T1"`. Becomes the actor id. */
  id: string;
  /** The line it rides, e.g. `"red"`. */
  line: string;
  /** The tick of its first departure from the origin, phased by the timetable. */
  startTick: number;
}

/** The next action the FSM performs, with the stop index and travel direction it carries. */
type Pending =
  | { do: "depart"; index: number; dir: 1 | -1 }
  | {
      do: "arrive";
      from: number;
      to: number;
      dir: 1 | -1;
      /** The polyline point indices of the hop being ridden, for on-track rendering. */
      fromPoint: number;
      toPoint: number;
    };

/** The physical track between two adjacent stops: deterministic and direction-free. */
function trackId(line: string, a: string, b: string): string {
  const [low, high] = a < b ? [a, b] : [b, a];
  return `${line}:${low}-${high}`;
}

/**
 * The presence a fixture train carries before its first departure: parked `at` its
 * origin from tick 0 until its scheduled launch. The engine builds it from the first
 * tick the schedule reports for the fixture.
 */
export function initialTrainPresence(origin: string, firstTick: number, line: string): Presence {
  // The origin is the line's first polyline point (index 0); rail from === to marks a
  // train at rest there, so the view parks it on the offset track, not the raw center.
  return {
    kind: "at",
    node: origin,
    fromTick: 0,
    untilTick: firstTick,
    rail: { line, from: 0, to: 0 },
  };
}

/**
 * Build one persistent train over its config. The returned actor holds its own ride
 * state; the scheduler owns its next tick. Each transition emits one `train-tracker`
 * `WorldReading` (a `dep` on leaving a stop, an `arr` on reaching one) and a matching
 * presence. It reads its line's schedule from `env.timetable` each transition.
 */
export function createTrain(config: TrainConfig): Actor<WorldReading, WorldEnv> {
  let pending: Pending = { do: "depart", index: 0, dir: 1 };

  return {
    id: config.id,
    start: () => config.startTick,
    act: ({ env, tick }) => {
      const schedule = env.timetable.line(config.line);
      const stops = schedule.stops;
      const ts = tick * GAME_SECONDS_PER_TICK;

      if (pending.do === "depart") {
        const here = pending.index;
        // The shared stepping decides the next stop, the hop, and the polyline points
        // this leg rides, so the train and a rider's `nextService` move identically. A
        // malformed hop is re-scoped to this actor, keeping the original error message.
        let leg: ReturnType<typeof stepLeg>;
        try {
          leg = stepLeg(schedule, here, pending.dir, tick);
        } catch (error) {
          throw new Error(
            `train "${config.id}": bad hop on line "${config.line}" at stop index ${here} (dir ${pending.dir}).`,
            {
              cause: error,
            },
          );
        }
        const nextTick = leg.arrTick;
        const reading: WorldReading = {
          sensor: "train-tracker",
          reading: {
            ts,
            train: config.id,
            line: config.line,
            station: leg.fromStation,
            event: "dep",
            track: trackId(config.line, leg.fromStation, leg.toStation),
          },
        };
        const presence: Presence = {
          kind: "moving",
          from: leg.fromStation,
          to: leg.toStation,
          line: config.line,
          fromTick: tick,
          untilTick: nextTick,
          rail: { line: config.line, from: leg.fromPoint, to: leg.toPoint },
        };
        pending = {
          do: "arrive",
          from: here,
          to: leg.toIndex,
          dir: leg.dir,
          fromPoint: leg.fromPoint,
          toPoint: leg.toPoint,
        };
        return { readings: [reading], nextTick, presence };
      }

      // ARRIVE: reach the stop, then dwell before the next departure.
      const fromStation = stops[pending.from];
      const atStation = stops[pending.to];
      if (fromStation === undefined || atStation === undefined) {
        throw new Error(`train "${config.id}": bad arrival on line "${config.line}".`);
      }
      const nextTick = tick + schedule.dwellTicks;
      const reading: WorldReading = {
        sensor: "train-tracker",
        reading: {
          ts,
          train: config.id,
          line: config.line,
          station: atStation,
          event: "arr",
          track: trackId(config.line, fromStation, atStation),
        },
      };
      const presence: Presence = {
        kind: "at",
        node: atStation,
        fromTick: tick,
        untilTick: nextTick,
        // Rest on the arrival end of the hop just ridden, keeping its tangent, so the
        // train does not snap to the raw station center or lose its heading while dwelling.
        rail: { line: config.line, from: pending.fromPoint, to: pending.toPoint },
      };
      pending = { do: "depart", index: pending.to, dir: pending.dir };
      return { readings: [reading], nextTick, presence };
    },
  };
}
