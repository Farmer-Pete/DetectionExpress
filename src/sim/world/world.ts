/**
 * The world environment: the runtime authority on `world.json`. The sim imports
 * the JSON at build time and `parseWorld` narrows and validates it, so a bad edit
 * fails a test rather than reaching a run. Everything here is pure, read-only data
 * the actors read; the environment never reads back (see ADR-0007).
 */
import worldJson from "../../../docs/world/world.json";

/**
 * A trust layer, 0 (public) to 4 (the control floor). A door's grade is a zone's
 * `trustLevel`. Every field is `readonly`, and the parsed world is deep-frozen, so
 * an actor can read the environment but never mutate it (see ADR-0007).
 */
interface Zone {
  readonly id: string;
  readonly name: string;
  readonly trustLevel: number;
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
  readonly type: string;
  readonly zonesPresent: readonly string[];
  readonly nearestStation: string;
  readonly description: string;
}

/** The Operations Control Center: the one control-center location. */
interface ControlCenter {
  readonly id: string;
  readonly name: string;
  readonly type: string;
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
 * A string primitive. The tag check alone also passes a boxed `new String("x")`,
 * which is an object, so the `instanceof String` clause excludes it.
 */
function isString(value: unknown): value is string {
  return Object.prototype.toString.call(value) === "[object String]" && !(value instanceof String);
}

/** A finite number, the only numeric a travel time or trust level may be. */
function isFiniteNumber(value: unknown): value is number {
  return Number.isFinite(value);
}

/** A boolean primitive, by its tag. The `instanceof` clause excludes a boxed `Boolean`. */
function isBoolean(value: unknown): value is boolean {
  return (
    Object.prototype.toString.call(value) === "[object Boolean]" && !(value instanceof Boolean)
  );
}

/** An array of string primitives. */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

/** The site-type enum from `world.schema.json`. A site's `type` must be one of these. */
const SITE_TYPES: readonly string[] = ["depot", "signal-cabin", "substation"];

function parseZone(value: unknown): Zone {
  if (!(value instanceof Object)) {
    throw new Error("world.zones: each zone must be an object.");
  }
  if (
    !(
      "id" in value &&
      "name" in value &&
      "trustLevel" in value &&
      "area" in value &&
      "whoBelongs" in value &&
      "securityParallel" in value &&
      "description" in value
    )
  ) {
    throw new Error("world.zones: a zone is missing a required field.");
  }
  const { id, name, trustLevel, area, whoBelongs, securityParallel, description } = value;
  if (
    !(
      isString(id) &&
      isString(name) &&
      isFiniteNumber(trustLevel) &&
      isString(area) &&
      isString(whoBelongs) &&
      isString(securityParallel) &&
      isString(description)
    )
  ) {
    throw new Error("world.zones: a zone field has the wrong type.");
  }
  if (!Number.isInteger(trustLevel) || trustLevel < 0 || trustLevel > 4) {
    throw new Error(`world.zones: zone "${id}" trustLevel must be an integer in [0, 4].`);
  }
  if (!/^z[0-4]$/.test(id)) {
    throw new Error(`world.zones: zone id "${id}" must match ^z[0-4]$.`);
  }
  return { id, name, trustLevel, area, whoBelongs, securityParallel, description };
}

function parseLine(value: unknown): Line {
  if (!(value instanceof Object)) {
    throw new Error("world.lines: each line must be an object.");
  }
  if (
    !(
      "id" in value &&
      "name" in value &&
      "color" in value &&
      "stations" in value &&
      "loop" in value &&
      "description" in value
    )
  ) {
    throw new Error("world.lines: a line is missing a required field.");
  }
  const { id, name, color, stations, loop, description } = value;
  if (
    !(
      isString(id) &&
      isString(name) &&
      isString(color) &&
      isStringArray(stations) &&
      isBoolean(loop) &&
      isString(description)
    )
  ) {
    throw new Error("world.lines: a line field has the wrong type.");
  }
  return { id, name, color, stations, loop, description };
}

function parseConnection(value: unknown): Connection {
  if (!(value instanceof Object)) {
    throw new Error("world.stations: each connection must be an object.");
  }
  if (!("to" in value && "line" in value && "minutes" in value)) {
    throw new Error("world.stations: a connection is missing a required field.");
  }
  const { to, line, minutes } = value;
  if (!(isString(to) && isString(line) && isFiniteNumber(minutes))) {
    throw new Error("world.stations: a connection field has the wrong type.");
  }
  return { to, line, minutes };
}

function parseStation(value: unknown): Station {
  if (!(value instanceof Object)) {
    throw new Error("world.stations: each station must be an object.");
  }
  if (
    !(
      "id" in value &&
      "name" in value &&
      "lines" in value &&
      "interchange" in value &&
      "connections" in value &&
      "description" in value
    )
  ) {
    throw new Error("world.stations: a station is missing a required field.");
  }
  const { id, name, lines, interchange, connections, description } = value;
  if (
    !(
      isString(id) &&
      isString(name) &&
      isStringArray(lines) &&
      isBoolean(interchange) &&
      Array.isArray(connections) &&
      isString(description)
    )
  ) {
    throw new Error("world.stations: a station field has the wrong type.");
  }
  return {
    id,
    name,
    lines,
    interchange,
    connections: connections.map(parseConnection),
    description,
  };
}

function parseSite(value: unknown): Site {
  if (!(value instanceof Object)) {
    throw new Error("world.sites: each site must be an object.");
  }
  if (
    !(
      "id" in value &&
      "name" in value &&
      "type" in value &&
      "zonesPresent" in value &&
      "nearestStation" in value &&
      "description" in value
    )
  ) {
    throw new Error("world.sites: a site is missing a required field.");
  }
  const { id, name, type, zonesPresent, nearestStation, description } = value;
  if (
    !(
      isString(id) &&
      isString(name) &&
      isString(type) &&
      isStringArray(zonesPresent) &&
      isString(nearestStation) &&
      isString(description)
    )
  ) {
    throw new Error("world.sites: a site field has the wrong type.");
  }
  if (!SITE_TYPES.includes(type)) {
    throw new Error(`world.sites: site "${id}" has unknown type "${type}".`);
  }
  return { id, name, type, zonesPresent, nearestStation, description };
}

function parseControlCenter(value: unknown): ControlCenter {
  if (!(value instanceof Object)) {
    throw new Error("world.controlCenter: must be an object.");
  }
  if (
    !(
      "id" in value &&
      "name" in value &&
      "type" in value &&
      "zonesPresent" in value &&
      "description" in value
    )
  ) {
    throw new Error("world.controlCenter: a required field is missing.");
  }
  const { id, name, type, zonesPresent, description } = value;
  if (
    !(
      isString(id) &&
      isString(name) &&
      isString(type) &&
      isStringArray(zonesPresent) &&
      isString(description)
    )
  ) {
    throw new Error("world.controlCenter: a field has the wrong type.");
  }
  if (type !== "control-center") {
    throw new Error(`world.controlCenter: type must be "control-center", got "${type}".`);
  }
  return { id, name, type, zonesPresent, description };
}

function parseDoor(value: unknown): Door {
  if (!(value instanceof Object)) {
    throw new Error("world.doors: each door must be an object.");
  }
  if (!("location" in value && "locationType" in value && "name" in value && "zone" in value)) {
    throw new Error("world.doors: a door is missing a required field.");
  }
  const { location, locationType, name, zone } = value;
  if (
    !(
      isString(location) &&
      (locationType === "site" || locationType === "control-center") &&
      isString(name) &&
      isString(zone)
    )
  ) {
    throw new Error("world.doors: a door field has the wrong type or value.");
  }
  return { location, locationType, name, zone };
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
function requireUniqueIds(ids: string[], label: string): void {
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
 * Check every referential and graph invariant `parseWorld` is the authority on.
 * Each throw names the exact break so a bad `world.json` edit reads clearly in CI.
 */
function validateWorld(world: World): void {
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

/**
 * Narrow and validate an untyped value into a `World`. Pure. It reads fields and
 * checks them with no type assertions, and throws a clear error on any missing or
 * malformed field, any duplicate id, any membership, connection, or graph break,
 * and any dangling site, zone, or door reference.
 */
export function parseWorld(value: unknown): World {
  if (!(value instanceof Object)) {
    throw new Error("world must be an object.");
  }
  if (
    !(
      "zones" in value &&
      "lines" in value &&
      "stations" in value &&
      "sites" in value &&
      "controlCenter" in value &&
      "doors" in value
    )
  ) {
    throw new Error("world is missing a top-level field.");
  }
  const { zones, lines, stations, sites, controlCenter, doors } = value;
  if (
    !(
      Array.isArray(zones) &&
      Array.isArray(lines) &&
      Array.isArray(stations) &&
      Array.isArray(sites) &&
      Array.isArray(doors)
    )
  ) {
    throw new Error("world: zones, lines, stations, sites, and doors must be arrays.");
  }
  const world: World = {
    zones: zones.map(parseZone),
    lines: lines.map(parseLine),
    stations: stations.map(parseStation),
    sites: sites.map(parseSite),
    controlCenter: parseControlCenter(controlCenter),
    doors: doors.map(parseDoor),
  };
  validateWorld(world);
  deepFreeze(world);
  return world;
}

/** The singleton world, validated once from the imported `world.json`. */
export const world: World = parseWorld(worldJson);

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
