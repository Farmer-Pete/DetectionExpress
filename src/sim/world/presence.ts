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
 * A stationary actor sits `at` a node from `fromTick`; a fixture whose next act is
 * far off uses `untilTick: "open"`. A `moving` actor rides one line's edge between
 * two nodes, always with `untilTick > fromTick`, because a moving actor is mid-trip
 * with a known arrival.
 */
export type Presence =
  | { kind: "at"; node: MapNodeId; fromTick: number; untilTick: number | "open" }
  | {
      kind: "moving";
      from: MapNodeId;
      to: MapNodeId;
      line: string;
      fromTick: number;
      untilTick: number;
    };
