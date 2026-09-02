/**
 * The sensor and manufacturer leaf types. A leaf file with no other project
 * dependency, so `sensors.data.ts` and `manufacturers.data.ts` can each `as const
 * satisfies` it with no import cycle (GH127-PLAN.md "Import cycle").
 */

/**
 * A telemetry payload's field values: every sensor and vendor payload is flat. Not
 * exported: nothing outside this file names the shape directly.
 */
type PayloadFields = Readonly<Record<string, string | number>>;

/**
 * Where a sensor physically sits: zones, stations, and/or sites, plus a one-line
 * summary. Not exported: nothing outside `Sensor` names this shape directly.
 */
interface SensorLocation {
  readonly summary: string;
  readonly zones?: readonly string[];
  readonly stations?: readonly string[];
  readonly sites?: readonly string[];
}

/**
 * One vendor's build of a sensor: its model name, its wire quirk, and a worked
 * example. Not exported: nothing outside `Sensor` names this shape directly.
 */
interface SensorManufacturer {
  readonly manufacturerId: string;
  readonly model: string;
  readonly quirk: string;
  readonly exampleRaw: PayloadFields;
}

/** One sensor kind: what it reads, where it sits, and the vendors that build it. */
export interface Sensor {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly foundAt: SensorLocation;
  readonly normalizedExample: PayloadFields;
  readonly manufacturers: readonly SensorManufacturer[];
}

/** The whole sensor catalogue. */
export interface SensorData {
  readonly sensors: readonly Sensor[];
}

/** One vendor: its house style and the sensor ids it builds. */
export interface Manufacturer {
  readonly id: string;
  readonly name: string;
  readonly tagline: string;
  readonly description: string;
  readonly dataStyle: string;
  readonly makes: readonly string[];
}

/** The whole manufacturer catalogue. */
export interface ManufacturerData {
  readonly manufacturers: readonly Manufacturer[];
}
