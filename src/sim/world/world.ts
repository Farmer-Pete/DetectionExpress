/**
 * The world environment: the runtime authority on the world's referential and graph
 * invariants. The shape itself is now a compile-time contract (`worldData` in
 * `./world.data` is `as const satisfies World`), so `tsc` rejects a malformed field
 * before a test ever runs. `assertWorldConsistent` holds only what a type cannot
 * express: cross-references, graph connectivity, uniqueness, and finite ranges. Every
 * field is `readonly`, and the world is deep-frozen, so an actor can read the
 * environment but never mutate it (see ADR-0007, ADR-0011).
 */
import { lineIdForTrain } from "./timetable";
import { worldData } from "./world.data";

/**
 * A trust layer, 0 (public) to 4 (the control floor). A door's grade is a zone's
 * `trustLevel`. Every field is `readonly`, and the parsed world is deep-frozen, so
 * an actor can read the environment but never mutate it (see ADR-0007).
 */
interface Zone {
  readonly id: string;
  readonly name: string;
  readonly trustLevel: 0 | 1 | 2 | 3 | 4;
  readonly area: string;
  readonly whoBelongs: string;
  readonly securityParallel: string;
  readonly description: string;
}

/** A line: an ordered run of stations, the wire a rider tapping a fare gate reports. */
interface Line {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly stations: readonly string[];
  readonly loop: boolean;
  readonly description: string;
  /** The line's train, as the UI shows it, e.g. "Red Line train". Never generated. */
  readonly trainName: string;
}

/** An undirected edge to a neighbor on a line, with its ride time in minutes. */
interface Connection {
  readonly to: string;
  readonly line: string;
  readonly minutes: number;
}

/** A passenger stop. A station on two or more lines is an interchange. */
interface Station {
  readonly id: string;
  readonly name: string;
  readonly lines: readonly string[];
  readonly interchange: boolean;
  readonly connections: readonly Connection[];
  readonly description: string;
}

/** A staff-only facility off the passenger map, near one station. */
interface Site {
  readonly id: string;
  readonly name: string;
  readonly type: "depot" | "signal-cabin" | "substation";
  readonly zonesPresent: readonly string[];
  readonly nearestStation: string;
  readonly description: string;
}

/** The Operations Control Center: the one control-center location. */
interface ControlCenter {
  readonly id: string;
  readonly name: string;
  readonly type: "control-center";
  readonly zonesPresent: readonly string[];
  readonly description: string;
}

/**
 * An access-controlled door. It guards one zone at a site or the control center.
 * The grade is derived (`grade = zone.trustLevel`), never stored; the lookup key
 * is `(location, name)`. This slice seeds only `site` and `control-center` doors.
 */
interface Door {
  readonly location: string;
  readonly locationType: "site" | "control-center";
  readonly name: string;
  readonly zone: string;
}

/** The whole validated world. Deeply read-only: the environment never changes during a run. */
export interface World {
  readonly zones: readonly Zone[];
  readonly lines: readonly Line[];
  readonly stations: readonly Station[];
  readonly sites: readonly Site[];
  readonly controlCenter: ControlCenter;
  readonly doors: readonly Door[];
}

/**
 * Recursively `Object.freeze` a value and every object it holds, so a runtime
 * mutation of the shared world fails rather than silently breaking determinism.
 */
function deepFreeze(value: unknown): void {
  if (!(value instanceof Object)) {
    return;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
}

/** Throw on the first repeated id in a list, naming the collection. */
function requireUniqueIds(ids: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      throw new Error(`world: duplicate ${label} id "${id}".`);
    }
    seen.add(id);
  }
}

/** Prove the undirected station graph is one connected component. */
function requireConnectedStationGraph(stations: readonly Station[]): void {
  const start = stations[0]?.id;
  if (start === undefined) {
    return;
  }
  const adjacency = new Map<string, string[]>();
  for (const station of stations) {
    adjacency.set(station.id, []);
  }
  for (const station of stations) {
    for (const connection of station.connections) {
      adjacency.get(station.id)?.push(connection.to);
    }
  }
  const seen = new Set<string>([start]);
  const queue = [start];
  for (let head = 0; head < queue.length; head++) {
    const current = queue[head];
    if (current === undefined) {
      continue;
    }
    for (const next of adjacency.get(current) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  if (seen.size !== stations.length) {
    throw new Error("world.stations: the station graph is not fully connected.");
  }
}

/** The zones a door's location offers, or undefined when the location does not resolve. */
function zonesAtDoorLocation(world: World, door: Door): readonly string[] | undefined {
  if (door.locationType === "site") {
    return world.sites.find((site) => site.id === door.location)?.zonesPresent;
  }
  return world.controlCenter.id === door.location ? world.controlCenter.zonesPresent : undefined;
}

/**
 * Check every referential, graph, and range invariant the `World` type cannot
 * express: unique ids, membership reciprocity, connection resolution and weight
 * symmetry, graph connectivity, dangling zone/station/door references, a zone's
 * `^z[0-4]$` id, and every `minutes` a finite number (a type only promises `number`,
 * which admits `NaN` and `Infinity`). Each throw names the exact break so a bad
 * `world.data.ts` edit reads clearly in CI. Runs once at load (see ARCHITECTURE
 * rule 9: validate at seams; trust types inside).
 */
export function assertWorldConsistent(world: World): void {
  requireUniqueIds(
    world.zones.map((zone) => zone.id),
    "zone",
  );
  requireUniqueIds(
    world.lines.map((line) => line.id),
    "line",
  );
  requireUniqueIds(
    world.stations.map((station) => station.id),
    "station",
  );
  requireUniqueIds(
    world.sites.map((site) => site.id),
    "site",
  );

  for (const zone of world.zones) {
    if (!/^z[0-4]$/.test(zone.id)) {
      throw new Error(`world.zones: zone id "${zone.id}" must match ^z[0-4]$.`);
    }
    // `trustLevel` is a `0 | 1 | 2 | 3 | 4` literal union, so `tsc` rejects a bad
    // literal in `world.data.ts`. This mirrors that range for a mutated test clone,
    // which reaches this function through a runtime cast the compiler cannot see.
    if (!Number.isInteger(zone.trustLevel) || zone.trustLevel < 0 || zone.trustLevel > 4) {
      throw new Error(`world.zones: zone "${zone.id}" trustLevel must be an integer in [0, 4].`);
    }
  }

  const zoneIds = new Set(world.zones.map((zone) => zone.id));
  const lineById = new Map(world.lines.map((line) => [line.id, line]));
  const stationById = new Map(world.stations.map((station) => [station.id, station]));

  // Line and station membership must agree both ways: each names the other.
  for (const line of world.lines) {
    for (const stationId of line.stations) {
      const station = stationById.get(stationId);
      if (station === undefined) {
        throw new Error(`world.lines: line "${line.id}" names unknown station "${stationId}".`);
      }
      if (!station.lines.includes(line.id)) {
        throw new Error(
          `world: line "${line.id}" and station "${stationId}" disagree on membership.`,
        );
      }
    }
  }
  for (const station of world.stations) {
    for (const lineId of station.lines) {
      const line = lineById.get(lineId);
      if (line === undefined) {
        throw new Error(`world.stations: station "${station.id}" names unknown line "${lineId}".`);
      }
      if (!line.stations.includes(station.id)) {
        throw new Error(
          `world: station "${station.id}" and line "${lineId}" disagree on membership.`,
        );
      }
    }
  }

  // Every connection resolves, rides a line holding both endpoints, has a positive
  // weight, and carries a reciprocal edge of equal weight (edges are undirected).
  for (const station of world.stations) {
    for (const connection of station.connections) {
      const neighbor = stationById.get(connection.to);
      if (neighbor === undefined) {
        throw new Error(
          `world.stations: station "${station.id}" connects to unknown station "${connection.to}".`,
        );
      }
      const line = lineById.get(connection.line);
      if (line === undefined) {
        throw new Error(
          `world.stations: station "${station.id}" has a connection on unknown line "${connection.line}".`,
        );
      }
      if (!(line.stations.includes(station.id) && line.stations.includes(connection.to))) {
        throw new Error(
          `world.stations: line "${connection.line}" does not contain both "${station.id}" and "${connection.to}".`,
        );
      }
      if (!Number.isFinite(connection.minutes)) {
        throw new Error(
          `world.stations: non-finite travel time between "${station.id}" and "${connection.to}".`,
        );
      }
      if (station.id !== connection.to && connection.minutes <= 0) {
        throw new Error(
          `world.stations: non-positive travel time between "${station.id}" and "${connection.to}".`,
        );
      }
      const back = neighbor.connections.find(
        (edge) => edge.to === station.id && edge.line === connection.line,
      );
      if (back === undefined) {
        throw new Error(
          `world.stations: connection "${station.id}"->"${connection.to}" on "${connection.line}" has no reciprocal edge.`,
        );
      }
      if (back.minutes !== connection.minutes) {
        throw new Error(
          `world.stations: connection "${station.id}"<->"${connection.to}" on "${connection.line}" has unequal weights.`,
        );
      }
    }
  }

  requireConnectedStationGraph(world.stations);

  // Every consecutive pair in a line's ordered `stations` must share a reciprocal
  // edge on that line, of equal weight, so `sharedLineRoute` and `lineMinutes` can
  // walk the sequence. The loop line's sequence already returns to its start, so
  // iterating consecutive pairs also covers its closing edge.
  for (const line of world.lines) {
    for (let index = 0; index + 1 < line.stations.length; index++) {
      const here = line.stations[index];
      const next = line.stations[index + 1];
      if (here === undefined || next === undefined) {
        continue;
      }
      const forward = stationById
        .get(here)
        ?.connections.find((edge) => edge.to === next && edge.line === line.id);
      if (forward === undefined) {
        throw new Error(
          `world.lines: line "${line.id}" sequence "${here}"->"${next}" has no matching edge.`,
        );
      }
      const back = stationById
        .get(next)
        ?.connections.find((edge) => edge.to === here && edge.line === line.id);
      if (back === undefined) {
        throw new Error(
          `world.lines: line "${line.id}" sequence "${here}"->"${next}" has no reciprocal edge.`,
        );
      }
      if (back.minutes !== forward.minutes) {
        throw new Error(
          `world.lines: line "${line.id}" sequence "${here}"<->"${next}" has unequal weights.`,
        );
      }
    }
  }

  for (const site of world.sites) {
    if (!stationById.has(site.nearestStation)) {
      throw new Error(
        `world.sites: site "${site.id}" nearestStation "${site.nearestStation}" does not resolve.`,
      );
    }
    for (const zoneId of site.zonesPresent) {
      if (!zoneIds.has(zoneId)) {
        throw new Error(`world.sites: site "${site.id}" names unknown zone "${zoneId}".`);
      }
    }
  }
  for (const zoneId of world.controlCenter.zonesPresent) {
    if (!zoneIds.has(zoneId)) {
      throw new Error(`world.controlCenter: names unknown zone "${zoneId}".`);
    }
  }

  // A location id must be unique across stations, sites, and the control center,
  // so a door's `(location, name)` key can never resolve to two places.
  requireUniqueIds(
    [
      ...world.stations.map((station) => station.id),
      ...world.sites.map((site) => site.id),
      world.controlCenter.id,
    ],
    "location",
  );

  const doorKeys = new Set<string>();
  for (const door of world.doors) {
    const present = zonesAtDoorLocation(world, door);
    if (present === undefined) {
      throw new Error(
        `world.doors: door "${door.name}" location "${door.location}" does not resolve for locationType "${door.locationType}".`,
      );
    }
    if (!zoneIds.has(door.zone)) {
      throw new Error(`world.doors: door "${door.name}" names unknown zone "${door.zone}".`);
    }
    if (!present.includes(door.zone)) {
      throw new Error(
        `world.doors: door "${door.name}" zone "${door.zone}" is not present at "${door.location}".`,
      );
    }
    const key = `${door.location}::${door.name}`;
    if (doorKeys.has(key)) {
      throw new Error(`world.doors: duplicate door key (${door.location}, ${door.name}).`);
    }
    doorKeys.add(key);
  }
}

/** The singleton world: the typed data, deep-frozen, then checked once at load. */
export const world: World = worldData;
deepFreeze(world);
assertWorldConsistent(world);

/** The trust level of a zone. Throws on an unknown zone id. */
export function zoneTrustLevel(zoneId: string): number {
  const zone = world.zones.find((candidate) => candidate.id === zoneId);
  if (zone === undefined) {
    throw new Error(`unknown zone "${zoneId}".`);
  }
  return zone.trustLevel;
}

/**
 * The grade of a door: the trust level of the zone it guards. The key is
 * `(location, door)`. Throws on an unknown door.
 */
export function doorGrade(location: string, door: string): number {
  const found = world.doors.find(
    (candidate) => candidate.location === location && candidate.name === door,
  );
  if (found === undefined) {
    throw new Error(`unknown door (${location}, ${door}).`);
  }
  return zoneTrustLevel(found.zone);
}

/**
 * The world-entity name resolvers (GH127-PLAN.md M2): every id that reaches the
 * screen resolves through one of these, never a repeated inline `world.x.find(...)`
 * and never a generated or concatenated string (the hard rule: names and flavor text
 * come only from the world and sensor data constants). `stationName`/`siteName`/
 * `lineName`/`zoneName`/`trainName` throw on an unknown id, matching
 * `zoneTrustLevel`/`doorGrade` above. `placeName` is the one exception: it resolves a
 * station, a site, OR the control-center id — the world-log ring and the event
 * dialog's Source line mix all three under one id space — and falls back to the raw
 * id for one that names none of the three, the same defensive fallback the private
 * `nodeLabel` it replaces (formerly in `place-view.ts`) always had.
 */

/** A station's display name. Throws on an unknown station id. */
export function stationName(stationId: string): string {
  const station = world.stations.find((candidate) => candidate.id === stationId);
  if (station === undefined) {
    throw new Error(`unknown station "${stationId}".`);
  }
  return station.name;
}

/** A site's display name. Throws on an unknown site id. */
export function siteName(siteId: string): string {
  const site = world.sites.find((candidate) => candidate.id === siteId);
  if (site === undefined) {
    throw new Error(`unknown site "${siteId}".`);
  }
  return site.name;
}

/** A line's display name. Throws on an unknown line id. */
export function lineName(lineId: string): string {
  const line = world.lines.find((candidate) => candidate.id === lineId);
  if (line === undefined) {
    throw new Error(`unknown line "${lineId}".`);
  }
  return line.name;
}

/** A zone's display name. Throws on an unknown zone id. */
export function zoneName(zoneId: string): string {
  const zone = world.zones.find((candidate) => candidate.id === zoneId);
  if (zone === undefined) {
    throw new Error(`unknown zone "${zoneId}".`);
  }
  return zone.name;
}

/**
 * A station, a site, or the control-center id's display name. Falls back to the raw
 * id when it names none of the three, so a stale or otherwise-unresolvable id renders
 * as itself rather than throwing and crashing a dialog.
 */
export function placeName(placeId: string): string {
  const station = world.stations.find((candidate) => candidate.id === placeId);
  if (station !== undefined) {
    return station.name;
  }
  const site = world.sites.find((candidate) => candidate.id === placeId);
  if (site !== undefined) {
    return site.name;
  }
  if (world.controlCenter.id === placeId) {
    return world.controlCenter.name;
  }
  return placeId;
}

/**
 * A train's display name: its line's authored `trainName` constant (never a
 * generated `${lineName} train` concatenation — see M1). Throws on a train id no
 * line derives, via `lineIdForTrain`.
 */
export function trainName(trainId: string): string {
  const lineId = lineIdForTrain(world, trainId);
  const line = world.lines.find((candidate) => candidate.id === lineId);
  if (line === undefined) {
    // Unreachable: `lineIdForTrain` only ever returns an id drawn from `world.lines`.
    throw new Error(`trainName: line "${lineId}" not found.`);
  }
  return line.trainName;
}
