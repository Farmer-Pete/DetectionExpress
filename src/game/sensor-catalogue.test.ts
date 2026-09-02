import { describe, expect, it } from "vitest";
import type { Manufacturer, Sensor } from "./sensor.types";
import { indexSensorCatalogue, sensorCatalogueEntry } from "./sensor-catalogue";

/** A minimal manufacturer fixture, only the fields `indexSensorCatalogue` reads. */
function manufacturer(overrides: Partial<Manufacturer> & Pick<Manufacturer, "id">): Manufacturer {
  return {
    name: "Fixture Vendor",
    tagline: "",
    description: "",
    dataStyle: "",
    makes: [],
    ...overrides,
  };
}

/** A minimal sensor fixture, only the fields `indexSensorCatalogue` reads. */
function sensor(overrides: Partial<Sensor> & Pick<Sensor, "id">): Sensor {
  return {
    name: "Fixture Sensor",
    description: "A fixture.",
    foundAt: { summary: "" },
    normalizedExample: {},
    manufacturers: [],
    ...overrides,
  };
}

describe("indexSensorCatalogue", () => {
  it("resolves a sensor id to its name, description, and vendor display names", () => {
    const catalogue = indexSensorCatalogue(
      [
        sensor({
          id: "fare-gate",
          name: "Fare gate",
          description: "The turnstile that guards the paid area.",
          manufacturers: [
            { manufacturerId: "gatekeep", model: "Gatekeep TurnKey 5", quirk: "", exampleRaw: {} },
            { manufacturerId: "veritap", model: "VeriTap FlowGate", quirk: "", exampleRaw: {} },
          ],
        }),
      ],
      [manufacturer({ id: "gatekeep" }), manufacturer({ id: "veritap" })],
    );
    expect(catalogue.get("fare-gate")).toEqual({
      name: "Fare gate",
      description: "The turnstile that guards the paid area.",
      vendors: ["Gatekeep TurnKey 5", "VeriTap FlowGate"],
    });
  });

  it("throws when a sensor names a manufacturerId with no matching manufacturer", () => {
    expect(() =>
      indexSensorCatalogue(
        [
          sensor({
            id: "fare-gate",
            manufacturers: [
              { manufacturerId: "ghost", model: "Ghost Gate", quirk: "", exampleRaw: {} },
            ],
          }),
        ],
        [],
      ),
    ).toThrow(/ghost/);
  });

  it("throws on a duplicate sensor id, naming both sensors", () => {
    expect(() =>
      indexSensorCatalogue(
        [sensor({ id: "fare-gate", name: "First" }), sensor({ id: "fare-gate", name: "Second" })],
        [],
      ),
    ).toThrow(/duplicate/i);
  });
});

describe("sensorCatalogueEntry", () => {
  it("resolves a real sensors.data id to its catalogue entry", () => {
    const entry = sensorCatalogueEntry("fare-gate");
    expect(entry.name).toBe("Fare gate");
    expect(entry.vendors).toEqual(["Gatekeep TurnKey 5", "VeriTap FlowGate", "RailSense GateNode"]);
  });

  it("throws on an unknown sensor id", () => {
    expect(() => sensorCatalogueEntry("nope")).toThrow(/unknown sensor/);
  });
});
