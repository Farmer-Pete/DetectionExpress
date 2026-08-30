import { describe, expect, it } from "vitest";
import type { Point } from "../../sim/world/layout";
import type { Presence } from "../../sim/world/presence";
import { presencePoint } from "./interpolate";

const layout = new Map<string, Point>([
  ["cen", { x: 470, y: 300 }],
  ["mkt", { x: 250, y: 300 }],
]);

describe("presencePoint", () => {
  it("draws an at presence at its node, whatever the tick", () => {
    const presence: Presence = { kind: "at", node: "cen", fromTick: 10, untilTick: 20 };
    expect(presencePoint(presence, layout, 0)).toEqual({ x: 470, y: 300 });
    expect(presencePoint(presence, layout, 15)).toEqual({ x: 470, y: 300 });
  });

  it("draws an at presence with an open end at its node", () => {
    const presence: Presence = { kind: "at", node: "mkt", fromTick: 4, untilTick: "open" };
    expect(presencePoint(presence, layout, 99)).toEqual({ x: 250, y: 300 });
  });

  it("returns the endpoints and the midpoint of a moving presence", () => {
    const presence: Presence = {
      kind: "moving",
      from: "cen",
      to: "mkt",
      line: "blue",
      fromTick: 100,
      untilTick: 200,
    };
    expect(presencePoint(presence, layout, 100)).toEqual({ x: 470, y: 300 });
    expect(presencePoint(presence, layout, 200)).toEqual({ x: 250, y: 300 });
    expect(presencePoint(presence, layout, 150)).toEqual({ x: 360, y: 300 });
  });

  it("clamps a moving presence outside its window to the endpoints", () => {
    const presence: Presence = {
      kind: "moving",
      from: "cen",
      to: "mkt",
      line: "blue",
      fromTick: 100,
      untilTick: 200,
    };
    expect(presencePoint(presence, layout, 50)).toEqual({ x: 470, y: 300 }); // before -> from
    expect(presencePoint(presence, layout, 500)).toEqual({ x: 250, y: 300 }); // after -> to
  });
});
