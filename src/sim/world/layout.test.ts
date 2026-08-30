import { describe, expect, it } from "vitest";
import { gateNodeId, metroLayout, metroLines, metroNodes } from "./layout";
import { world } from "./world";

describe("metroLayout", () => {
  const layout = metroLayout(world);

  it("places every station at its ported coordinate", () => {
    expect(layout.get("har")).toEqual({ x: 90, y: 300 });
    expect(layout.get("cen")).toEqual({ x: 470, y: 300 });
    expect(layout.get("bay")).toEqual({ x: 782, y: 110 });
    expect(layout.get("sum")).toEqual({ x: 300, y: 544 });
  });

  it("places every site and the OCC at its ported coordinate", () => {
    expect(layout.get("dep")).toEqual({ x: 578, y: 520 });
    expect(layout.get("sig")).toEqual({ x: 398, y: 546 });
    expect(layout.get("sub")).toEqual({ x: 742, y: 398 });
    expect(layout.get("occ")).toEqual({ x: 470, y: 128 });
  });

  it("places every node at a distinct point", () => {
    const parents = [...world.stations.map((s) => s.id), "dep", "sig", "sub", "occ"];
    const seen = new Set<string>();
    for (const id of parents) {
      const point = layout.get(id);
      expect(point).toBeDefined();
      const key = `${point?.x},${point?.y}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it("derives a station's four sensor chips in a row centered under it, pitch 9", () => {
    // Row center is (cx, cy + 30); chips K, G, V, C at x = cx - (n-1)*9/2 + i*9.
    expect(layout.get("cen:kiosk")).toEqual({ x: 470 - 13.5 + 0 * 9, y: 330 });
    expect(layout.get("cen:gate")).toEqual({ x: 470 - 13.5 + 1 * 9, y: 330 });
    expect(layout.get("cen:tvm")).toEqual({ x: 470 - 13.5 + 2 * 9, y: 330 });
    expect(layout.get("cen:camera")).toEqual({ x: 470 - 13.5 + 3 * 9, y: 330 });
  });

  it("derives site and OCC chips from each location's own sensor set (row +26)", () => {
    // Substation has three chips (R, D, N: no train tracker), centered on x=742, y+26.
    expect(layout.get("sub:reader")).toEqual({ x: 742 - 9 + 0 * 9, y: 424 });
    expect(layout.get("sub:contact")).toEqual({ x: 742 - 9 + 1 * 9, y: 424 });
    expect(layout.get("sub:relay")).toEqual({ x: 742 - 9 + 2 * 9, y: 424 });
    expect(layout.has("sub:train")).toBe(false);
    // The OCC console chip exists only at the OCC.
    expect(layout.get("occ:console")).toBeDefined();
  });

  it("exposes the gate node id a fare-gate flash lands on", () => {
    expect(gateNodeId("cen")).toBe("cen:gate");
    expect(layout.get(gateNodeId("cen"))).toEqual(layout.get("cen:gate"));
  });
});

describe("metroNodes", () => {
  const nodes = metroNodes(world);
  const byId = new Map(nodes.map((node) => [node.id, node]));

  it("marks the dominant zone on sites and the OCC from their zonesPresent", () => {
    expect(byId.get("dep")?.zone).toBe(3); // z2, z3 -> 3
    expect(byId.get("occ")?.zone).toBe(4); // z2, z3, z4 -> 4
    expect(byId.get("cen")?.zone).toBeUndefined(); // stations carry no zone badge
  });

  it("gives every station four chips and the OCC four chips", () => {
    expect(byId.get("cen")?.chips).toHaveLength(4);
    expect(byId.get("occ")?.chips).toHaveLength(4);
    expect(byId.get("sub")?.chips).toHaveLength(3);
  });
});

describe("metroLines", () => {
  const lines = metroLines(world);
  const byId = new Map(lines.map((line) => [line.id, line]));

  it("uses the world.json colors and station counts, in the fixed line order", () => {
    expect(lines.map((line) => line.id)).toEqual(["red", "blue", "green", "circle"]);
    expect(byId.get("red")?.color).toBe("#e6394a");
    expect(byId.get("red")?.points).toHaveLength(5);
    expect(byId.get("circle")?.loop).toBe(true);
  });

  it("offsets a shared segment so parallel track separates", () => {
    // Red (offset -7.5) and blue (offset -2.5) both run cen<->mkt; their cen points
    // must not coincide once each line's perpendicular offset is applied.
    const redCen = byId.get("red")?.points[2];
    const blueCen = byId.get("blue")?.points[1];
    expect(redCen).toBeDefined();
    expect(blueCen).toBeDefined();
    expect(redCen).not.toEqual(blueCen);
  });
});
