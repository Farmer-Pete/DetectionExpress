import { describe, expect, it } from "vitest";
import { gateNodeId, metroLayout, metroLines, metroNodes, type Point } from "./layout";
import { world } from "./world";

describe("metroLayout", () => {
  const layout = metroLayout(world);

  it("places every station at its ported coordinate", () => {
    expect(layout.get("har")).toEqual({ x: 90, y: 300 });
    expect(layout.get("cen")).toEqual({ x: 470, y: 300 });
    expect(layout.get("bay")).toEqual({ x: 782, y: 110 });
    expect(layout.get("sum")).toEqual({ x: 300, y: 544 });
  });

  it("places every site and the OCC at its GH116 side-placement coordinate", () => {
    // GH116: sites moved beside their station, clear of the chip band. See
    // GH116-PLAN.md "Commit 1" for the verified coordinate table.
    expect(layout.get("dep")).toEqual({ x: 545, y: 455 });
    expect(layout.get("sig")).toEqual({ x: 375, y: 455 });
    expect(layout.get("sub")).toEqual({ x: 735, y: 345 });
    expect(layout.get("occ")).toEqual({ x: 575, y: 345 });
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
    // Substation has three chips (R, D, N: no train tracker), centered on x=735, y+26.
    expect(layout.get("sub:reader")).toEqual({ x: 735 - 9 + 0 * 9, y: 371 });
    expect(layout.get("sub:contact")).toEqual({ x: 735 - 9 + 1 * 9, y: 371 });
    expect(layout.get("sub:relay")).toEqual({ x: 735 - 9 + 2 * 9, y: 371 });
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

  it("uses the world-data colors and station counts, in the fixed line order", () => {
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

/**
 * GH116 placement geometry invariant. Ports `scripts/gh116-placement-check.ts` (a
 * planning-only, uncommitted checker) into a real test, so a future coordinate edit
 * that collides with a station, a chip, a rail segment, another site, or the canvas
 * fails CI instead of only a manual eyeball. Visual constants (station radius incl.
 * stroke, chip size, site badge size, rail stroke half-width) mirror the renderer.
 */
describe("site placement geometry (GH116)", () => {
  const nodes = metroNodes(world);
  const stations = nodes.filter((node) => node.kind === "station");
  const sites = nodes.filter((node) => node.kind === "site" || node.kind === "occ");
  const lines = metroLines(world);

  const CANVAS = { w: 960, h: 600 };
  const STATION_R = 9.25; // station circle radius incl. stroke
  const CHIP_HALF = 4; // sensor chip is 8x8
  const BOX_HALF_X = 29; // site badge is 58 wide
  const BOX_HALF_Y = 15; // site badge is 30 tall
  const TRACK_HALF = 2.75; // rail stroke is 5.5
  // The site must stay near its station, not far. A few sites carry a long name label
  // (e.g. "Operations Control Center") whose width forces them a touch further out so
  // the label clears the rail and its neighbours; 80 admits that while still meaning near.
  const MAX_STATION_GAP = 80;
  // Approximate label geometry (a render concern, mirrored here to guard against a
  // future close-placement that overlaps labels the way GH116's first pass did). Widths
  // are measured from the rendered SVG: site name ~5.6 u/char (11px), station name
  // ~6.8 u/char (13px). A site name sits centered at y in [point.y - 11, point.y]; a
  // station name at y in [point.y - 24, point.y - 13].
  const SITE_CHAR_W = 5.6;
  const STATION_CHAR_W = 6.8;
  const LABEL_GAP = 5; // required whitespace between two labels

  interface Rect {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    tag: string;
  }

  function boxRect(id: string, point: Point): Rect {
    return {
      x0: point.x - BOX_HALF_X,
      y0: point.y - BOX_HALF_Y,
      x1: point.x + BOX_HALF_X,
      y1: point.y + BOX_HALF_Y,
      tag: `${id}-box`,
    };
  }

  function chipRect(chip: { id: string; point: Point }): Rect {
    return {
      x0: chip.point.x - CHIP_HALF,
      y0: chip.point.y - CHIP_HALF,
      x1: chip.point.x + CHIP_HALF,
      y1: chip.point.y + CHIP_HALF,
      tag: chip.id,
    };
  }

  function rectsOverlap(a: Rect, b: Rect): boolean {
    return a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
  }

  function circleHitsRect(center: Point, radius: number, rect: Rect): boolean {
    const nx = Math.max(rect.x0, Math.min(center.x, rect.x1));
    const ny = Math.max(rect.y0, Math.min(center.y, rect.y1));
    return Math.hypot(center.x - nx, center.y - ny) < radius;
  }

  /** Liang-Barsky segment-vs-expanded-rect intersection: true if the stroked segment hits the rect. */
  function segHitsRect(a: Point, b: Point, rect: Rect, margin: number): boolean {
    const x0 = rect.x0 - margin;
    const y0 = rect.y0 - margin;
    const x1 = rect.x1 + margin;
    const y1 = rect.y1 + margin;
    let t0 = 0;
    let t1 = 1;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const p = [-dx, dx, -dy, dy];
    const q = [a.x - x0, x1 - a.x, a.y - y0, y1 - a.y];
    for (let i = 0; i < 4; i++) {
      const pi = p[i] ?? 0;
      const qi = q[i] ?? 0;
      if (pi === 0) {
        if (qi < 0) {
          return false;
        }
      } else {
        const t = qi / pi;
        if (pi < 0) {
          t0 = Math.max(t0, t);
        } else {
          t1 = Math.min(t1, t);
        }
      }
    }
    return t0 <= t1;
  }

  function gapToStationEdge(box: Rect, station: Point): number {
    const nx = Math.max(box.x0, Math.min(station.x, box.x1));
    const ny = Math.max(box.y0, Math.min(station.y, box.y1));
    return Math.hypot(station.x - nx, station.y - ny) - STATION_R;
  }

  function siteLabelRect(name: string, point: Point): Rect {
    const half = (name.length * SITE_CHAR_W) / 2 + LABEL_GAP;
    return {
      x0: point.x - half,
      y0: point.y - 11,
      x1: point.x + half,
      y1: point.y,
      tag: `${name}-label`,
    };
  }

  function stationLabelRect(name: string, point: Point): Rect {
    const half = (name.length * STATION_CHAR_W) / 2;
    return {
      x0: point.x - half,
      y0: point.y - 24,
      x1: point.x + half,
      y1: point.y - 13,
      tag: `${name}-stnlabel`,
    };
  }

  const stationLabels = stations.map((station) => stationLabelRect(station.name, station.point));
  const siteLabels = sites.map((site) => ({
    id: site.id,
    rect: siteLabelRect(site.name, site.point),
  }));

  for (const site of sites) {
    const box = boxRect(site.id, site.point);
    const rects = [box, ...site.chips.map(chipRect)];

    it(`${site.id}: its box and chip row stay within the 960x600 canvas`, () => {
      for (const rect of rects) {
        expect(rect.x0).toBeGreaterThanOrEqual(0);
        expect(rect.y0).toBeGreaterThanOrEqual(0);
        expect(rect.x1).toBeLessThanOrEqual(CANVAS.w);
        expect(rect.y1).toBeLessThanOrEqual(CANVAS.h);
      }
    });

    it(`${site.id}: its box and chip row clear every station circle`, () => {
      for (const station of stations) {
        for (const rect of rects) {
          expect(circleHitsRect(station.point, STATION_R, rect)).toBe(false);
        }
      }
    });

    it(`${site.id}: its box and chip row clear every station's own chips`, () => {
      for (const station of stations) {
        for (const stationChip of station.chips) {
          const stationChipRect = chipRect(stationChip);
          for (const rect of rects) {
            expect(rectsOverlap(rect, stationChipRect)).toBe(false);
          }
        }
      }
    });

    it(`${site.id}: its box and chip row clear every rail track segment`, () => {
      for (const line of lines) {
        for (let i = 0; i + 1 < line.points.length; i++) {
          const a = line.points[i];
          const b = line.points[i + 1];
          if (a === undefined || b === undefined) {
            continue;
          }
          for (const rect of rects) {
            expect(segHitsRect(a, b, rect, TRACK_HALF)).toBe(false);
          }
        }
      }
    });

    it(`${site.id}: its box and chip row clear every other site's box`, () => {
      for (const other of sites) {
        if (other.id === site.id) {
          continue;
        }
        const otherBox = boxRect(other.id, other.point);
        for (const rect of rects) {
          expect(rectsOverlap(rect, otherBox)).toBe(false);
        }
      }
    });

    it(`${site.id}: its name label clears every station label, other site label, and the rail`, () => {
      const label = siteLabelRect(site.name, site.point);
      for (const stationLabel of stationLabels) {
        expect(rectsOverlap(label, stationLabel)).toBe(false);
      }
      for (const other of siteLabels) {
        if (other.id === site.id) {
          continue;
        }
        expect(rectsOverlap(label, other.rect)).toBe(false);
      }
      for (const line of lines) {
        for (let i = 0; i + 1 < line.points.length; i++) {
          const a = line.points[i];
          const b = line.points[i + 1];
          if (a === undefined || b === undefined) {
            continue;
          }
          expect(segHitsRect(a, b, label, TRACK_HALF)).toBe(false);
        }
      }
    });

    it(`${site.id}: sits close to its nearest station (gap under ${MAX_STATION_GAP}u, not overlapping)`, () => {
      let nearestGap = Number.POSITIVE_INFINITY;
      for (const station of stations) {
        nearestGap = Math.min(nearestGap, gapToStationEdge(box, station.point));
      }
      expect(nearestGap).toBeGreaterThanOrEqual(0);
      expect(nearestGap).toBeLessThan(MAX_STATION_GAP);
    });
  }
});
