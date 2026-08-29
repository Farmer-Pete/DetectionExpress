/**
 * Station distances over the undirected connection graph. `distanceTable` computes
 * all-pairs shortest travel time once; `distanceMinutes` reads it; `sharedLineRoute`
 * names the single-line ride a fare-gate reading needs. All pure, no RNG (ADR-0007).
 */
import type { World } from "./world";

/** All-pairs shortest travel time in minutes, keyed `from -> to -> minutes`. */
export type DistanceTable = ReadonlyMap<string, ReadonlyMap<string, number>>;

/**
 * The shortest travel time in minutes between every pair of stations, computed
 * once with Floyd-Warshall over the undirected graph. The graph is validated
 * connected, so every off-diagonal entry is finite.
 */
export function distanceTable(world: World): DistanceTable {
  const ids = world.stations.map((station) => station.id);
  const dist = new Map<string, Map<string, number>>();
  for (const from of ids) {
    const row = new Map<string, number>();
    for (const to of ids) {
      row.set(to, from === to ? 0 : Number.POSITIVE_INFINITY);
    }
    dist.set(from, row);
  }

  // Seed the direct edges, taking the smallest weight across any parallel lines.
  for (const station of world.stations) {
    const row = dist.get(station.id);
    if (row === undefined) {
      continue;
    }
    for (const connection of station.connections) {
      const current = row.get(connection.to) ?? Number.POSITIVE_INFINITY;
      if (connection.minutes < current) {
        row.set(connection.to, connection.minutes);
      }
    }
  }

  for (const through of ids) {
    for (const from of ids) {
      for (const to of ids) {
        const left = dist.get(from)?.get(through);
        const right = dist.get(through)?.get(to);
        const direct = dist.get(from)?.get(to);
        if (left === undefined || right === undefined || direct === undefined) {
          continue;
        }
        if (left + right < direct) {
          dist.get(from)?.set(to, left + right);
        }
      }
    }
  }

  return dist;
}

/** The shortest travel time in minutes, symmetric and zero on the diagonal. Throws on an unknown station. */
export function distanceMinutes(table: DistanceTable, from: string, to: string): number {
  const row = table.get(from);
  if (row === undefined) {
    throw new Error(`unknown station "${from}".`);
  }
  const minutes = row.get(to);
  if (minutes === undefined) {
    throw new Error(`unknown station "${to}".`);
  }
  return minutes;
}

/** The ride time in minutes along one line between two of its stations. */
function lineMinutes(world: World, lineId: string, from: string, to: string): number {
  const line = world.lines.find((candidate) => candidate.id === lineId);
  if (line === undefined) {
    throw new Error(`unknown line "${lineId}".`);
  }
  const sequence = line.stations;
  const start = sequence.indexOf(from);
  const end = sequence.indexOf(to);
  if (start < 0 || end < 0) {
    throw new Error(`line "${lineId}" does not run through both "${from}" and "${to}".`);
  }
  const step = start <= end ? 1 : -1;
  let total = 0;
  for (let index = start; index !== end; index += step) {
    const here = sequence[index];
    const next = sequence[index + step];
    if (here === undefined || next === undefined) {
      throw new Error(`line "${lineId}" has a gap between "${from}" and "${to}".`);
    }
    const station = world.stations.find((candidate) => candidate.id === here);
    const edge = station?.connections.find((c) => c.to === next && c.line === lineId);
    if (edge === undefined) {
      throw new Error(`line "${lineId}" has no edge from "${here}" to "${next}".`);
    }
    total += edge.minutes;
  }
  return total;
}

/**
 * The direct single-line ride between two stations that share a line: the minutes
 * along that line and the line to ride. When they share more than one line it picks
 * the lowest line id, so Central to Market rides "blue", not a coin toss. Returns
 * null when no line is shared. Throws on an unknown station.
 */
export function sharedLineRoute(
  world: World,
  from: string,
  to: string,
): { minutes: number; line: string } | null {
  const origin = world.stations.find((station) => station.id === from);
  const destination = world.stations.find((station) => station.id === to);
  if (origin === undefined) {
    throw new Error(`unknown station "${from}".`);
  }
  if (destination === undefined) {
    throw new Error(`unknown station "${to}".`);
  }
  const shared = origin.lines.filter((lineId) => destination.lines.includes(lineId)).sort();
  const line = shared[0];
  if (line === undefined) {
    return null;
  }
  return { minutes: lineMinutes(world, line, from, to), line };
}
