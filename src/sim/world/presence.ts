/**
 * Presence: where an actor is, and until when. The schedule steps in whole ticks
 * and jumps between due actors, so the view needs a semantic position it can
 * interpolate over `[fromTick, untilTick]`, not a pixel. The actor reports it on a
 * transition; the engine overlays it onto the actor's view.
 *
 * This lives in its own small module so `actor.ts` (which carries a presence on a
 * transition result) and `world-snapshot.ts` (which carries a presence on an actor
 * view) both read it without importing each other. Pure data, no React (it sits in
 * `src/sim/`).
 */

/** A place on the map: a station, site, control center, gate, terminal, or console. */
export type MapNodeId = string;

/**
 * Optional rendering metadata that pins an actor to a specific segment of a line's
 * offset polyline, by point index. A train sets it so the view rides the actual drawn
 * track: a loop repeats a station id (the Circle's stops are cen, jct, cen), so a
 * `(line, station)` point lookup is ambiguous, but point indices are not. It also lets
 * a dwelling train keep its arriving tangent and stay on its offset platform. Riders
 * and other actors omit it and are placed by their station node. Additive and
 * view-only: the sim never reads it.
 */
interface RailPlacement {
  /** The line whose offset polyline the actor rides. */
  line: string;
  /** The polyline point index the actor left (the segment's near end). */
  from: number;
  /** The polyline point index the actor rides to, or rests on while `at`. */
  to: number;
}

/**
 * A stationary actor sits `at` a node from `fromTick`; a fixture whose next act is
 * far off uses `untilTick: "open"`. A `moving` actor rides one line's edge between
 * two nodes, always with `untilTick > fromTick`, because a moving actor is mid-trip
 * with a known arrival. Either may carry a `rail` placement for exact on-track drawing.
 */
export type Presence =
  | {
      kind: "at";
      node: MapNodeId;
      fromTick: number;
      untilTick: number | "open";
      rail?: RailPlacement;
    }
  | {
      kind: "moving";
      from: MapNodeId;
      to: MapNodeId;
      line: string;
      fromTick: number;
      untilTick: number;
      rail?: RailPlacement;
    };
