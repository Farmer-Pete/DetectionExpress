/**
 * The sensor catalogue: `sensors.data` indexed by id, its vendor list resolved
 * through `manufacturers.data`. `sensors.data.ts` is the single source of truth for
 * a sensor's display name, description, and vendor lineup (GH127-PLAN.md M2), so
 * this is the one lookup every UI surface reads instead of a hardcoded table.
 * Mirrors `registry.ts`'s `indexCatalogue` pattern: pure over its inputs, so a test
 * injects its own fixtures rather than the real data.
 */
import { manufacturersData } from "./manufacturers.data";
import type { Manufacturer, Sensor } from "./sensor.types";
import { sensorsData } from "./sensors.data";

/** One sensor's resolved display facts: its name, description, and the vendor
 *  models that build it, each already qualified with its maker's name (see
 *  `sensors.data.ts`, e.g. `"Gatekeep TurnKey 5"`) — never concatenated here. */
export interface SensorCatalogueEntry {
  readonly name: string;
  readonly description: string;
  readonly vendors: readonly string[];
}

/** A sensor's `manufacturers` entries resolved to their vendor display strings.
 *  Throws when a `manufacturerId` names no real manufacturer, so a data typo in
 *  `sensors.data.ts` fails loudly here rather than silently rendering nothing. */
function resolveVendors(
  sensor: Sensor,
  manufacturerById: ReadonlyMap<string, Manufacturer>,
): string[] {
  return sensor.manufacturers.map((entry) => {
    if (!manufacturerById.has(entry.manufacturerId)) {
      throw new Error(
        `sensor-catalogue: sensor "${sensor.id}" names unknown manufacturer "${entry.manufacturerId}".`,
      );
    }
    return entry.model;
  });
}

/**
 * Index a sensor list by id, resolving each one's vendor list through a
 * manufacturer list. Throws on a duplicate sensor id (a data bug, not a silent
 * overwrite) and on an unresolved `manufacturerId` (see `resolveVendors`).
 */
export function indexSensorCatalogue(
  sensors: readonly Sensor[],
  manufacturers: readonly Manufacturer[],
): Map<string, SensorCatalogueEntry> {
  const manufacturerById = new Map(
    manufacturers.map((manufacturer) => [manufacturer.id, manufacturer]),
  );
  const byId = new Map<string, SensorCatalogueEntry>();
  for (const sensor of sensors) {
    if (byId.has(sensor.id)) {
      throw new Error(`sensor-catalogue: duplicate sensor id "${sensor.id}".`);
    }
    byId.set(sensor.id, {
      name: sensor.name,
      description: sensor.description,
      vendors: resolveVendors(sensor, manufacturerById),
    });
  }
  return byId;
}

/** The real catalogue, built once from `sensors.data` and `manufacturers.data`. */
const catalogueById = indexSensorCatalogue(sensorsData.sensors, manufacturersData.manufacturers);

/** One sensor's resolved catalogue entry, keyed on its `sensors.data` id (the same
 *  id a `SensorKind` and a chip's `sensor` field already carry). Throws on an
 *  unknown id, mirroring `zoneTrustLevel`/`doorGrade`'s unknown-id contract. */
export function sensorCatalogueEntry(id: string): SensorCatalogueEntry {
  const entry = catalogueById.get(id);
  if (entry === undefined) {
    throw new Error(`sensor-catalogue: unknown sensor "${id}".`);
  }
  return entry;
}
