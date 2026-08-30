/**
 * Presence interpolation: turn an actor's semantic presence into a design-space
 * point at a given render tick. The schedule steps in whole ticks and jumps between
 * due actors, so the canvas interpolates each actor's `moving` presence over
 * `[fromTick, untilTick]` against a fractional render estimate of `nowTick`. An `at`
 * presence sits on its node. Pure: it reads the layout and the presence, nothing
 * else, so it is unit-tested without a canvas.
 */
import type { Point } from "../../sim/world/layout";
import type { MapNodeId, Presence } from "../../sim/world/presence";

const ORIGIN: Point = { x: 0, y: 0 };

/** The node's point, or the design-space origin when the layout has no such node. */
function pointOf(layout: ReadonlyMap<MapNodeId, Point>, node: MapNodeId): Point {
  return layout.get(node) ?? ORIGIN;
}

/** Linear blend between two points at fraction `t`. */
function lerp(from: Point, to: Point, t: number): Point {
  return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
}

/**
 * Where an actor is at `nowTick`, in design space. A `moving` actor is blended along
 * its line edge, clamped to the endpoints outside `[fromTick, untilTick]`; an `at`
 * actor rests on its node.
 */
export function presencePoint(
  presence: Presence,
  layout: ReadonlyMap<MapNodeId, Point>,
  nowTick: number,
): Point {
  if (presence.kind === "at") {
    return pointOf(layout, presence.node);
  }
  if (presence.kind === "onTrain") {
    // A boarded rider is placed near its train, which needs the whole snapshot; the
    // layer resolves that. Without the train this pure helper has no point to give.
    return ORIGIN;
  }
  const span = presence.untilTick - presence.fromTick;
  const raw = span <= 0 ? 1 : (nowTick - presence.fromTick) / span;
  const t = Math.max(0, Math.min(1, raw));
  return lerp(pointOf(layout, presence.from), pointOf(layout, presence.to), t);
}
