/**
 * The metro map layout: a pure, deterministic placement of every node in a fixed
 * 960 x 600 design space. It ports the hand-tuned coordinate table from
 * `87-VIEW-NOTES.md` (nine stations, three sites, the OCC) and DERIVES each node's
 * sensor chips as a tight row centered under the parent, so the layout stays a pure
 * function of "what sensors a node has," not a second coordinate table.
 *
 * No RNG, no wall clock, no React (ADR-0007, ARCHITECTURE rule 8). The UI scales this
 * design space uniformly to the viewport; this module never sees a pixel. The rider's
 * presence uses station ids; a fare-gate flash uses a station's gate node id
 * (`gateNodeId`), which resolves to that station's gate chip position here.
 */
import type { MapNodeId } from "./presence";
import { type World, zoneTrustLevel } from "./world";

/** A point in the 960 x 600 design space. */
export interface Point {
  x: number;
  y: number;
}

/** The nine sensor chip codes drawn on the map (view notes section 6). */
export type SensorCode = "K" | "G" | "V" | "C" | "R" | "D" | "T" | "N" | "O";

/** One sensor chip under a node: its map id, its code and canonical sensor id, its point. */
interface Chip {
  id: MapNodeId;
  code: SensorCode;
  /** The canonical `sensors.data.ts` id, e.g. `"fare-gate"`, `"platform-camera"`. */
  sensor: string;
  point: Point;
}

/** A placed map node: a station, a site, or the control center, with its chips. */
export interface MapNode {
  id: MapNodeId;
  kind: "station" | "site" | "occ";
  name: string;
  point: Point;
  /** The dominant zone (max trust level) for a site or the OCC; stations carry none. */
  zone?: number;
  /** The dominant zone's own id (e.g. `"z3"`), alongside its numeric `zone` level, for
   *  a site or the OCC; stations carry none. `zoneName` (`world.ts`) reads this. */
  zoneId?: string | undefined;
  chips: readonly Chip[];
}

/** One line's offset-parallel polyline in its world-data color. */
export interface LinePolyline {
  id: string;
  color: string;
  loop: boolean;
  points: readonly Point[];
}

/** The ported station coordinate table (view notes section 1). */
const STATION_XY: Record<string, Point> = {
  har: { x: 90, y: 300 },
  mkt: { x: 250, y: 300 },
  cen: { x: 470, y: 300 },
  riv: { x: 680, y: 300 },
  end: { x: 872, y: 300 },
  prk: { x: 612, y: 176 },
  bay: { x: 782, y: 110 },
  jct: { x: 470, y: 468 },
  sum: { x: 300, y: 544 },
};

/**
 * The site and OCC coordinate table. GH116 moved every site beside its station
 * (not straight below it, which collides with the station's chip row) and moved
 * the OCC near Central. Sites are spread enough that each wide name label clears
 * its neighbours and the rail, not just the badge box. Verified clear of every
 * station circle, station chip, rail segment, other site box, and (approximately)
 * neighbouring labels by the geometry invariant in `layout.test.ts` (see
 * GH116-PLAN.md "Commit 1").
 */
const SITE_XY: Record<string, Point> = {
  dep: { x: 545, y: 455 },
  sig: { x: 375, y: 455 },
  sub: { x: 735, y: 345 },
};
const OCC_XY: Point = { x: 575, y: 345 };
const OCC_ID = "occ";

/** Every station draws the same four public sensor chips, in this order. */
const STATION_SENSORS: readonly SensorCode[] = ["K", "G", "V", "C"];

/** Each site's restricted sensor set; the OCC adds the control console. */
const SITE_SENSORS: Record<string, readonly SensorCode[]> = {
  dep: ["R", "D", "T", "N"],
  sig: ["R", "D", "T", "N"],
  sub: ["R", "D", "N"],
};
const OCC_SENSORS: readonly SensorCode[] = ["R", "D", "N", "O"];

/** A chip's node-id key: `${parent}:${key}`, e.g. `cen:gate`. */
const SENSOR_KEY: Record<SensorCode, string> = {
  K: "kiosk",
  G: "gate",
  V: "tvm",
  C: "camera",
  R: "reader",
  D: "contact",
  T: "train",
  N: "relay",
  O: "console",
};

/** The canonical `sensors.data.ts` id per chip code. */
const SENSOR_ID: Record<SensorCode, string> = {
  K: "kiosk",
  G: "fare-gate",
  V: "tvm",
  C: "platform-camera",
  R: "door-reader",
  D: "door-contact",
  T: "train-tracker",
  N: "network-relay",
  O: "occ-console",
};

/** The fixed line draw order, giving each line its perpendicular offset index. */
const LINE_ORDER: readonly string[] = ["red", "blue", "green", "circle"];

/** Chip pitch and the row drop below a station / a site node. */
const CHIP_PITCH = 9;
const STATION_ROW_DROP = 30;
const SITE_ROW_DROP = 26;

/** The gate node id a fare-gate reading's flash lands on: the station's gate chip. */
export function gateNodeId(station: string): MapNodeId {
  return `${station}:${SENSOR_KEY.G}`;
}

/**
 * The gate id the platform camera groups its counts by, derived from a station. A
 * fare-gate reading carries only its `station`, so the camera reducer maps that to a
 * gate through this typed function rather than changing `FareGateReading`. It is the
 * same gate the fare-gate tap flashes on (`gateNodeId`), so the camera and the tap
 * agree on which gate a rider crossed.
 */
export function gateIdForStation(station: string): string {
  return gateNodeId(station);
}

/** The camera (C) chip node a station's crowd-density mark is drawn on. */
export function cameraNodeId(station: string): MapNodeId {
  return `${station}:${SENSOR_KEY.C}`;
}

/** The kiosk (K) chip node an account sign-in flash lands on, at a station. */
export function kioskNodeId(station: string): MapNodeId {
  return `${station}:${SENSOR_KEY.K}`;
}

/** The TVM (V) chip node a card top-up flash lands on, at a station. */
export function tvmNodeId(station: string): MapNodeId {
  return `${station}:${SENSOR_KEY.V}`;
}

/** The door-reader (R) chip node a grant flash lands on, at a site or the OCC. */
export function readerNodeId(location: string): MapNodeId {
  return `${location}:${SENSOR_KEY.R}`;
}

/** The door-contact (D) chip node a door open/close flash and its state land on. */
export function contactNodeId(location: string): MapNodeId {
  return `${location}:${SENSOR_KEY.D}`;
}

/** The network-relay (N) chip node a relay flash lands on, at a site or the OCC. */
export function relayNodeId(location: string): MapNodeId {
  return `${location}:${SENSOR_KEY.N}`;
}

/** The control-console (O) chip node an OCC command flash lands on, at the OCC only. */
export function consoleNodeId(location: string): MapNodeId {
  return `${location}:${SENSOR_KEY.O}`;
}

/** The i-th of n chips in a row centered on `(cx, cy)`, at pitch 9. */
function chipPoint(cx: number, cy: number, index: number, count: number): Point {
  return { x: cx - ((count - 1) * CHIP_PITCH) / 2 + index * CHIP_PITCH, y: cy };
}

/** Build the chips for one node from its sensor codes and its row center. */
function chipsFor(
  parent: string,
  point: Point,
  codes: readonly SensorCode[],
  rowY: number,
): Chip[] {
  return codes.map((code, index) => ({
    id: `${parent}:${SENSOR_KEY[code]}`,
    code,
    sensor: SENSOR_ID[code],
    point: chipPoint(point.x, rowY, index, codes.length),
  }));
}

/** The dominant zone's own id (highest trust level) among a location's present
 *  zones, or undefined for a location that lists none. `zoneName` (`world.ts`)
 *  resolves this id to its display name; `dominantZone` below derives the
 *  numeric level from it, so the two can never disagree on which zone won. */
function dominantZoneId(zonesPresent: readonly string[]): string | undefined {
  return zonesPresent.reduce<string | undefined>((best, zoneId) => {
    if (best === undefined || zoneTrustLevel(zoneId) > zoneTrustLevel(best)) {
      return zoneId;
    }
    return best;
  }, undefined);
}

/** The dominant zone (highest trust level) among a location's present zones. */
function dominantZone(zonesPresent: readonly string[]): number {
  const id = dominantZoneId(zonesPresent);
  return id === undefined ? 0 : zoneTrustLevel(id);
}

/** Every placed node: stations, sites, and the OCC, each with its derived chips. */
export function metroNodes(world: World): MapNode[] {
  const nodes: MapNode[] = [];

  for (const station of world.stations) {
    const point = STATION_XY[station.id];
    if (point === undefined) {
      throw new Error(`metroLayout: no coordinate for station "${station.id}".`);
    }
    nodes.push({
      id: station.id,
      kind: "station",
      name: station.name,
      point,
      chips: chipsFor(station.id, point, STATION_SENSORS, point.y + STATION_ROW_DROP),
    });
  }

  for (const site of world.sites) {
    const point = SITE_XY[site.id];
    const codes = SITE_SENSORS[site.id];
    if (point === undefined || codes === undefined) {
      throw new Error(`metroLayout: no coordinate or sensor set for site "${site.id}".`);
    }
    nodes.push({
      id: site.id,
      kind: "site",
      name: site.name,
      point,
      zone: dominantZone(site.zonesPresent),
      zoneId: dominantZoneId(site.zonesPresent),
      chips: chipsFor(site.id, point, codes, point.y + SITE_ROW_DROP),
    });
  }

  nodes.push({
    id: OCC_ID,
    kind: "occ",
    name: world.controlCenter.name,
    point: OCC_XY,
    zone: dominantZone(world.controlCenter.zonesPresent),
    zoneId: dominantZoneId(world.controlCenter.zonesPresent),
    chips: chipsFor(OCC_ID, OCC_XY, OCC_SENSORS, OCC_XY.y + SITE_ROW_DROP),
  });

  return nodes;
}

/**
 * The positional map every drawer reads: each station, site, OCC, and derived chip
 * mapped to its point. Deterministic and pure; the tested seam for placement.
 */
export function metroLayout(world: World): ReadonlyMap<MapNodeId, Point> {
  const map = new Map<MapNodeId, Point>();
  for (const node of metroNodes(world)) {
    map.set(node.id, node.point);
    for (const chip of node.chips) {
      map.set(chip.id, chip.point);
    }
  }
  return map;
}

/**
 * Offset a line's station points along the local perpendicular so shared track reads
 * as parallel. The offset is `(orderIndex - 1.5) * 5` design units; each point is
 * pushed along the normal of its neighbors on that line.
 */
function offsetPoints(points: readonly Point[], offset: number): Point[] {
  if (offset === 0 || points.length < 2) {
    return points.map((point) => ({ ...point }));
  }
  return points.map((point, index) => {
    const before = points[Math.max(0, index - 1)];
    const after = points[Math.min(points.length - 1, index + 1)];
    if (before === undefined || after === undefined) {
      return { ...point };
    }
    let nx = -(after.y - before.y);
    let ny = after.x - before.x;
    const length = Math.hypot(nx, ny) || 1;
    nx /= length;
    ny /= length;
    return { x: point.x + nx * offset, y: point.y + ny * offset };
  });
}

/** Each line as an offset-parallel polyline in its world-data color, in the fixed order. */
export function metroLines(world: World): LinePolyline[] {
  const lineById = new Map(world.lines.map((line) => [line.id, line]));
  // LINE_ORDER fixes both draw order and parallel offset, so a world line missing from
  // it has no place to draw. Fail loudly at load rather than silently dropping it.
  const drawOrder = new Set<string>(LINE_ORDER);
  for (const line of world.lines) {
    if (!drawOrder.has(line.id)) {
      throw new Error(`metroLayout: line "${line.id}" is not in the draw order (LINE_ORDER).`);
    }
  }
  const lines: LinePolyline[] = [];
  for (const id of LINE_ORDER) {
    const line = lineById.get(id);
    if (line === undefined) {
      continue;
    }
    const offset = (LINE_ORDER.indexOf(id) - 1.5) * 5;
    const stationPoints: Point[] = line.stations.map((stationId) => {
      const point = STATION_XY[stationId];
      if (point === undefined) {
        throw new Error(
          `metroLayout: line "${id}" names station "${stationId}" with no coordinate.`,
        );
      }
      return point;
    });
    lines.push({
      id,
      color: line.color,
      loop: line.loop,
      points: offsetPoints(stationPoints, offset),
    });
  }
  return lines;
}
