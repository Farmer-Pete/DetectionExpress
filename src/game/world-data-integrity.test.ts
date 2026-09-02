import { describe, expect, it } from "vitest";
import { trainIdForLine } from "../sim/world/timetable";
import { trainName, world } from "../sim/world/world";
import type { CatalogueScenario } from "./catalogue.types";
import { manufacturersData } from "./manufacturers.data";
import { scenariosData } from "./scenarios.data";
import type { Manufacturer, Sensor } from "./sensor.types";
import { sensorsData } from "./sensors.data";

/**
 * The world-data integrity checks. Nothing enforced these cross-references before
 * this ticket: `sensors.json` and `manufacturers.json` had no importer at all, and
 * a scenario's `sensors` list, a sensor's `foundAt` ids, and a line's `trainName`
 * were never checked against the rest of the data (GH127-PLAN.md "New: world-data
 * integrity test"). Each check throws on the first break it finds; each is proven
 * both on the real data (must pass) and on a seeded broken clone (must throw), so a
 * silent pass here can never hide a missing check.
 */

/**
 * A mutable deep copy of any of this module's readonly data, for a seeded break.
 * `JSON.parse` returns `any`, so the clone sheds the source's readonly, `as const`
 * literal type and a test can mutate one field at a time.
 */
function clone(value: unknown) {
  return JSON.parse(JSON.stringify(value));
}

/** Every sensor names at least one manufacturer, and the sensor<->manufacturer link agrees both ways. */
function checkSensorManufacturerLinks(
  sensors: readonly Sensor[],
  manufacturers: readonly Manufacturer[],
): void {
  const manufacturerById = new Map(
    manufacturers.map((manufacturer) => [manufacturer.id, manufacturer]),
  );
  const sensorById = new Map(sensors.map((sensor) => [sensor.id, sensor]));

  for (const sensor of sensors) {
    if (sensor.manufacturers.length === 0) {
      throw new Error(`sensor "${sensor.id}" names no manufacturers.`);
    }
    for (const link of sensor.manufacturers) {
      const manufacturer = manufacturerById.get(link.manufacturerId);
      if (manufacturer === undefined) {
        throw new Error(
          `sensor "${sensor.id}" names unknown manufacturer "${link.manufacturerId}".`,
        );
      }
      if (!manufacturer.makes.includes(sensor.id)) {
        throw new Error(
          `sensor "${sensor.id}" names manufacturer "${manufacturer.id}", but "${manufacturer.id}".makes does not list "${sensor.id}".`,
        );
      }
    }
  }

  for (const manufacturer of manufacturers) {
    for (const sensorId of manufacturer.makes) {
      const sensor = sensorById.get(sensorId);
      if (sensor === undefined) {
        throw new Error(`manufacturer "${manufacturer.id}" makes unknown sensor "${sensorId}".`);
      }
      if (!sensor.manufacturers.some((link) => link.manufacturerId === manufacturer.id)) {
        throw new Error(
          `manufacturer "${manufacturer.id}" makes "${sensorId}", but sensor "${sensorId}" does not name "${manufacturer.id}".`,
        );
      }
    }
  }
}

/**
 * Every line carries a non-empty `trainName` (the UI's only source for a train's
 * display name, per the no-generation rule), and its derived train id
 * (`trainIdForLine`) resolves with no throw, so a line and its train id agree on
 * existing at all.
 */
function checkLineTrainNames(
  lines: readonly { readonly id: string; readonly trainName: string }[],
): void {
  for (const line of lines) {
    if (line.trainName.trim().length === 0) {
      throw new Error(`line "${line.id}" has an empty trainName.`);
    }
    const trainId = trainIdForLine(world, line.id);
    if (trainName(trainId) !== line.trainName) {
      throw new Error(
        `line "${line.id}" trainName "${line.trainName}" does not round-trip through train id "${trainId}".`,
      );
    }
  }
}

/** Every scenario's `sensors` id resolves to a real sensor. */
function checkScenarioSensorsResolve(
  scenarios: readonly CatalogueScenario[],
  sensors: readonly Sensor[],
): void {
  const sensorIds = new Set(sensors.map((sensor) => sensor.id));
  for (const scenario of scenarios) {
    for (const sensorId of scenario.sensors) {
      if (!sensorIds.has(sensorId)) {
        throw new Error(`scenario "${scenario.id}" names unknown sensor "${sensorId}".`);
      }
    }
  }
}

/**
 * Every sensor's `foundAt` id resolves, with the sentinels handled exactly: a zone
 * resolves against the world's zones, a station token is the `"all"` sentinel or a
 * real station id, and a site token resolves against the world's sites joined with
 * the control center id (the `"occ"` token is the control center, not a site).
 */
function checkFoundAtResolves(sensors: readonly Sensor[]): void {
  const zoneIds = new Set(world.zones.map((zone) => zone.id));
  const stationIds = new Set(world.stations.map((station) => station.id));
  const siteIds = new Set([...world.sites.map((site) => site.id), world.controlCenter.id]);

  for (const sensor of sensors) {
    for (const zoneId of sensor.foundAt.zones ?? []) {
      if (!zoneIds.has(zoneId)) {
        throw new Error(`sensor "${sensor.id}" foundAt.zones names unknown zone "${zoneId}".`);
      }
    }
    for (const stationToken of sensor.foundAt.stations ?? []) {
      if (stationToken !== "all" && !stationIds.has(stationToken)) {
        throw new Error(
          `sensor "${sensor.id}" foundAt.stations names unknown station "${stationToken}".`,
        );
      }
    }
    for (const siteToken of sensor.foundAt.sites ?? []) {
      if (!siteIds.has(siteToken)) {
        throw new Error(`sensor "${sensor.id}" foundAt.sites names unknown site "${siteToken}".`);
      }
    }
  }
}

describe("sensor<->manufacturer links", () => {
  it("holds for the real data", () => {
    expect(() =>
      checkSensorManufacturerLinks(sensorsData.sensors, manufacturersData.manufacturers),
    ).not.toThrow();
  });

  it("throws when a sensor names no manufacturers", () => {
    const sensors = clone(sensorsData.sensors);
    sensors[0].manufacturers = [];
    expect(() => checkSensorManufacturerLinks(sensors, manufacturersData.manufacturers)).toThrow(
      /names no manufacturers/,
    );
  });

  it("throws when a sensor names an unknown manufacturer", () => {
    const sensors = clone(sensorsData.sensors);
    sensors[0].manufacturers[0].manufacturerId = "nobody";
    expect(() => checkSensorManufacturerLinks(sensors, manufacturersData.manufacturers)).toThrow(
      /unknown manufacturer/,
    );
  });

  it("throws when a manufacturer's makes names an unknown sensor", () => {
    const manufacturers = clone(manufacturersData.manufacturers);
    manufacturers[0].makes.push("no-such-sensor");
    expect(() => checkSensorManufacturerLinks(sensorsData.sensors, manufacturers)).toThrow(
      /makes unknown sensor/,
    );
  });

  it("throws when a sensor names a manufacturer whose makes omits it (forward break)", () => {
    const manufacturers = clone(manufacturersData.manufacturers);
    const gatekeep = manufacturers.find((m: Manufacturer) => m.id === "gatekeep");
    gatekeep.makes = gatekeep.makes.filter((id: string) => id !== "kiosk");
    expect(() => checkSensorManufacturerLinks(sensorsData.sensors, manufacturers)).toThrow(
      /does not list/,
    );
  });

  it("throws when a manufacturer's makes names a sensor that omits it (reverse break)", () => {
    const sensors = clone(sensorsData.sensors);
    const kiosk = sensors.find((s: Sensor) => s.id === "kiosk");
    kiosk.manufacturers = kiosk.manufacturers.filter(
      (link: { manufacturerId: string }) => link.manufacturerId !== "gatekeep",
    );
    expect(() => checkSensorManufacturerLinks(sensors, manufacturersData.manufacturers)).toThrow(
      /does not name/,
    );
  });
});

describe("line train names", () => {
  it("holds for the real world", () => {
    expect(() => checkLineTrainNames(world.lines)).not.toThrow();
  });

  it("throws on an empty trainName", () => {
    const lines = clone(world.lines);
    lines[0].trainName = "";
    expect(() => checkLineTrainNames(lines)).toThrow(/empty trainName/);
  });

  it("throws when a trainName does not round-trip through its line's train id", () => {
    // A wrong but non-empty trainName skips the empty-string check above and
    // exercises the round-trip comparison instead. `trainName` reads the real
    // `world` singleton, so this clone's wrong value is guaranteed to mismatch it.
    const lines = clone(world.lines);
    lines[0].trainName = "Wrong Name";
    expect(() => checkLineTrainNames(lines)).toThrow(/does not round-trip/);
  });
});

describe("scenario sensors resolve", () => {
  it("holds for the real catalogue", () => {
    expect(() =>
      checkScenarioSensorsResolve(scenariosData.scenarios, sensorsData.sensors),
    ).not.toThrow();
  });

  it("throws when a scenario names an unknown sensor", () => {
    const scenarios = clone(scenariosData.scenarios);
    scenarios[0].sensors.push("no-such-sensor");
    expect(() => checkScenarioSensorsResolve(scenarios, sensorsData.sensors)).toThrow(
      /unknown sensor/,
    );
  });
});

describe("sensor foundAt resolves", () => {
  it("holds for the real data", () => {
    expect(() => checkFoundAtResolves(sensorsData.sensors)).not.toThrow();
  });

  it("throws on a foundAt.zones entry that names an unknown zone", () => {
    const sensors = clone(sensorsData.sensors);
    sensors[0].foundAt.zones = ["z9"];
    expect(() => checkFoundAtResolves(sensors)).toThrow(/foundAt.zones names unknown zone/);
  });

  it('throws on a foundAt.stations entry that is neither "all" nor a real station', () => {
    const sensors = clone(sensorsData.sensors);
    sensors[0].foundAt.stations = ["nowhere"];
    expect(() => checkFoundAtResolves(sensors)).toThrow(/foundAt.stations names unknown station/);
  });

  it("throws on a foundAt.sites entry that resolves against neither sites nor the control center", () => {
    const doorReader = clone(sensorsData.sensors).find((s: Sensor) => s.id === "door-reader");
    doorReader.foundAt.sites = ["nowhere"];
    expect(() => checkFoundAtResolves([doorReader])).toThrow(/foundAt.sites names unknown site/);
  });

  it('accepts the "occ" foundAt.sites token as the control center, not a site', () => {
    const doorReader = sensorsData.sensors.find((sensor) => sensor.id === "door-reader");
    expect(doorReader?.foundAt.sites).toContain("occ");
    expect(() => checkFoundAtResolves(sensorsData.sensors)).not.toThrow();
  });
});
