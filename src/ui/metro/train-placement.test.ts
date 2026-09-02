import { describe, expect, it } from "vitest";
import { metroLines, type Point } from "../../sim/world/layout";
import type { Presence } from "../../sim/world/presence";
import { world } from "../../sim/world/world";
import { movingFraction, trainPlacement } from "./train-placement";

const layout = new Map<string, Point>([
  ["cen", { x: 470, y: 300 }],
  ["riv", { x: 680, y: 300 }],
]);

/** The red line's own offset polyline points, so a rail test asserts against the
 *  exact segment the map draws, not a station-to-station straight line. */
const redLineId = world.lines.find((line) => line.name.toLowerCase().includes("red"))?.id ?? "red";

/** The red line's first drawn segment (`rail.from` 0 -> `rail.to` 1) taken straight from
 *  the offset polyline the renderer uses, so a rail test pins the exact point and tangent
 *  instead of accepting "differs from the station center" or "not NaN". */
const redPolyline = metroLines(world).find((poly) => poly.id === redLineId)?.points ?? [];
const railNear = redPolyline[0] ?? { x: 0, y: 0 };
const railFar = redPolyline[1] ?? { x: 0, y: 0 };
const railAngle = Math.atan2(railFar.y - railNear.y, railFar.x - railNear.x);

describe("movingFraction", () => {
  it("clamps to [0,1] and is linear in between", () => {
    expect(movingFraction(100, 200, 100)).toBe(0);
    expect(movingFraction(100, 200, 200)).toBe(1);
    expect(movingFraction(100, 200, 150)).toBe(0.5);
    expect(movingFraction(100, 200, 0)).toBe(0);
    expect(movingFraction(100, 200, 999)).toBe(1);
  });

  it("treats a non-positive span as fully arrived", () => {
    expect(movingFraction(100, 100, 100)).toBe(1);
  });
});

describe("trainPlacement", () => {
  it("rests at a station node with no facing when it carries no rail metadata", () => {
    const presence: Presence = { kind: "at", node: "cen", fromTick: 0, untilTick: 20 };
    expect(trainPlacement(presence, layout, 10)).toEqual({ point: { x: 470, y: 300 }, angle: 0 });
  });

  it("blends along a station-to-station edge with no rail metadata", () => {
    const presence: Presence = {
      kind: "moving",
      from: "cen",
      to: "riv",
      line: "red",
      fromTick: 100,
      untilTick: 200,
    };
    expect(trainPlacement(presence, layout, 150)).toEqual({
      point: { x: 575, y: 300 },
      angle: Math.atan2(0, 210),
    });
  });

  it("rides the exact drawn rail segment when rail metadata is present", () => {
    const presence: Presence = {
      kind: "moving",
      from: "cen",
      to: "riv",
      line: redLineId,
      fromTick: 0,
      untilTick: 10,
      rail: { line: redLineId, from: 0, to: 1 },
    };
    // Halfway through the wave, so t = 0.5: the point is the midpoint of the offset
    // polyline segment, and the facing is that segment's own tangent.
    const placement = trainPlacement(presence, layout, 5);
    expect(placement.point).toEqual({
      x: railNear.x + (railFar.x - railNear.x) * 0.5,
      y: railNear.y + (railFar.y - railNear.y) * 0.5,
    });
    expect(placement.angle).toBeCloseTo(railAngle);
    // The point rides the offset polyline, not the raw station centers this test's own
    // `layout` map holds — so it must not equal "cen".
    expect(placement.point).not.toEqual({ x: 470, y: 300 });
  });

  it("a dwelling train (kind 'at' with rail) rests on the rail segment's arrival point, tangent preserved", () => {
    const presence: Presence = {
      kind: "at",
      node: "riv",
      fromTick: 0,
      untilTick: "open",
      rail: { line: redLineId, from: 0, to: 1 },
    };
    const placement = trainPlacement(presence, layout, 0);
    // A dwelling train sits on the segment's far (arrival) point (t = 1) and keeps the
    // segment's tangent, so it does not rotate or snap when it stops.
    expect(placement.point).toEqual(railFar);
    expect(placement.angle).toBeCloseTo(railAngle);
  });

  it("returns the origin with no angle for the (unreachable) onTrain arm", () => {
    const presence: Presence = { kind: "onTrain", train: "T1", fromTick: 0, untilTick: 20 };
    expect(trainPlacement(presence, layout, 10)).toEqual({ point: { x: 0, y: 0 }, angle: 0 });
  });
});
