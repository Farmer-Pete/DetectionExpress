/**
 * Train placement geometry, shared between the passive canvas (`ActorLayer.tsx`) and
 * the focusable train hit target (`TrainHitTargets.tsx`, GH124-PLAN.md Checkpoint 4).
 * Extracted from `ActorLayer.tsx` verbatim (GH116's rail-riding design, see the
 * function doc below) so both consumers compute a train's point and facing angle from
 * the exact same source. A hit target driven by a second implementation — or worse, by
 * a slower 20 Hz React re-render off the published snapshot — would visibly lag the
 * 60 Hz `requestAnimationFrame` canvas; sharing this module is what keeps them pixel-
 * identical every frame.
 */
import { metroLines, type Point } from "../../sim/world/layout";
import type { Presence } from "../../sim/world/presence";
import { world } from "../../sim/world/world";

const ORIGIN: Point = { x: 0, y: 0 };

/**
 * Each line's offset-parallel polyline points, indexed by line id, built once from
 * the singleton `world` (mirrors `MetroMap.tsx`'s own line drawing, so a train rides
 * the exact segment drawn on screen, not a straight station-to-station line).
 */
const POINTS_BY_LINE = new Map<string, readonly Point[]>(
  metroLines(world).map((poly) => [poly.id, poly.points]),
);

/** The clamped `[0,1]` progress of a moving presence at `renderNow`. */
export function movingFraction(fromTick: number, untilTick: number, renderNow: number): number {
  const span = untilTick - fromTick;
  const raw = span <= 0 ? 1 : (renderNow - fromTick) / span;
  return Math.max(0, Math.min(1, raw));
}

export interface TrainPlacement {
  point: Point;
  angle: number;
}

/**
 * Where a train sits and which way it faces at `renderNow`. It reads the presence's
 * `rail` metadata and rides the exact drawn polyline segment: a moving train slides
 * from the segment's near point to its far point and faces that direction; a
 * dwelling train rests on the far (arrival) point, keeping the same tangent so it
 * does not rotate or snap when it stops. Without rail metadata it falls back to the
 * station node.
 */
export function trainPlacement(
  presence: Presence,
  layout: ReadonlyMap<string, Point>,
  renderNow: number,
): TrainPlacement {
  if (presence.kind === "onTrain") {
    // A train is never itself onTrain; this only satisfies the union. Boarded riders
    // are placed relative to their train's placement by the caller, not here.
    return { point: ORIGIN, angle: 0 };
  }
  const rail = presence.rail;
  if (rail !== undefined) {
    const points = POINTS_BY_LINE.get(rail.line) ?? [];
    const a = points[rail.from] ?? ORIGIN;
    const b = points[rail.to] ?? ORIGIN;
    const t =
      presence.kind === "moving"
        ? movingFraction(presence.fromTick, presence.untilTick, renderNow)
        : 1;
    const still = a.x === b.x && a.y === b.y;
    return {
      point: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t },
      angle: still ? 0 : Math.atan2(b.y - a.y, b.x - a.x),
    };
  }
  if (presence.kind === "at") {
    return { point: layout.get(presence.node) ?? ORIGIN, angle: 0 };
  }
  const from = layout.get(presence.from) ?? ORIGIN;
  const to = layout.get(presence.to) ?? ORIGIN;
  const t = movingFraction(presence.fromTick, presence.untilTick, renderNow);
  return {
    point: { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t },
    angle: Math.atan2(to.y - from.y, to.x - from.x),
  };
}
