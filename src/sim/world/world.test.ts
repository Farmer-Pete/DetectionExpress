import { describe, expect, it } from "vitest";
import worldJson from "../../../docs/world/world.json";
import { doorGrade, parseWorld, world, zoneTrustLevel } from "./world";

/**
 * A fresh, mutable deep copy of the real world data, typed loosely so a test can
 * break one invariant at a time. `parseWorld` takes `unknown`, so the mutated copy
 * flows in without a type assertion.
 */
function cloneWorld() {
  return JSON.parse(JSON.stringify(worldJson));
}

describe("parseWorld", () => {
  it("accepts the real world.json", () => {
    expect(() => parseWorld(worldJson)).not.toThrow();
  });

  it("throws on a missing top-level field", () => {
    const bad = cloneWorld();
    delete bad.doors;
    expect(() => parseWorld(bad)).toThrow(/top-level field/);
  });

  it("throws on a duplicate station id", () => {
    const bad = cloneWorld();
    bad.stations[1].id = bad.stations[0].id;
    expect(() => parseWorld(bad)).toThrow(/duplicate station id/);
  });

  it("throws on a location id that collides across stations and a site", () => {
    const bad = cloneWorld();
    bad.sites[0].id = bad.stations[0].id;
    expect(() => parseWorld(bad)).toThrow(/duplicate location id/);
  });

  it("throws on a non-reciprocal connection", () => {
    const bad = cloneWorld();
    // har <-> mkt on red is 3 minutes each way; drop mkt's edge back to har.
    const market = bad.stations.find((s: { id: string }) => s.id === "mkt");
    market.connections = market.connections.filter((c: { to: string }) => c.to !== "har");
    expect(() => parseWorld(bad)).toThrow(/reciprocal edge/);
  });

  it("throws on an unequal reciprocal weight", () => {
    const bad = cloneWorld();
    const market = bad.stations.find((s: { id: string }) => s.id === "mkt");
    const edge = market.connections.find((c: { to: string }) => c.to === "har");
    edge.minutes = 9;
    expect(() => parseWorld(bad)).toThrow(/unequal weights/);
  });

  it("throws on a non-positive travel time", () => {
    const bad = cloneWorld();
    for (const station of bad.stations) {
      for (const connection of station.connections) {
        if (
          (station.id === "har" && connection.to === "mkt") ||
          (station.id === "mkt" && connection.to === "har")
        ) {
          connection.minutes = 0;
        }
      }
    }
    expect(() => parseWorld(bad)).toThrow(/non-positive travel time/);
  });

  it("throws on a disconnected station graph", () => {
    const bad = cloneWorld();
    // Cut World's End off entirely, both directions, so the graph splits but every
    // remaining edge stays reciprocal. Only the connectivity check should fire.
    const end = bad.stations.find((s: { id: string }) => s.id === "end");
    end.connections = [];
    const riverside = bad.stations.find((s: { id: string }) => s.id === "riv");
    riverside.connections = riverside.connections.filter((c: { to: string }) => c.to !== "end");
    expect(() => parseWorld(bad)).toThrow(/not fully connected/);
  });

  it("throws on a door whose location does not resolve", () => {
    const bad = cloneWorld();
    bad.doors[0].location = "nowhere";
    expect(() => parseWorld(bad)).toThrow(/does not resolve for locationType/);
  });

  it("throws on a door zone not present at its location", () => {
    const bad = cloneWorld();
    // z4 exists but is not present at the depot site (dep has z2, z3 only).
    const store = bad.doors.find(
      (d: { location: string; name: string }) => d.location === "dep" && d.name === "STORE",
    );
    store.zone = "z4";
    expect(() => parseWorld(bad)).toThrow(/is not present at/);
  });

  it("throws on a duplicate door key", () => {
    const bad = cloneWorld();
    bad.doors.push({ location: "dep", locationType: "site", name: "STORE", zone: "z3" });
    expect(() => parseWorld(bad)).toThrow(/duplicate door key/);
  });

  it("throws on a duplicate zone id", () => {
    const bad = cloneWorld();
    bad.zones[1].id = bad.zones[0].id;
    expect(() => parseWorld(bad)).toThrow(/duplicate zone id/);
  });

  it("throws on a duplicate line id", () => {
    const bad = cloneWorld();
    bad.lines[1].id = bad.lines[0].id;
    expect(() => parseWorld(bad)).toThrow(/duplicate line id/);
  });

  it("throws on a duplicate site id", () => {
    const bad = cloneWorld();
    bad.sites[1].id = bad.sites[0].id;
    expect(() => parseWorld(bad)).toThrow(/duplicate site id/);
  });

  it("throws when a line and a station disagree on membership", () => {
    const bad = cloneWorld();
    // Red still names Harbor, but Harbor no longer names red.
    bad.stations.find((s: { id: string }) => s.id === "har").lines = [];
    expect(() => parseWorld(bad)).toThrow(/disagree on membership/);
  });

  it("throws on a connection to an unknown station", () => {
    const bad = cloneWorld();
    bad.stations.find((s: { id: string }) => s.id === "har").connections[0].to = "zzz";
    expect(() => parseWorld(bad)).toThrow(/connects to unknown station/);
  });

  it("throws on a connection whose line does not contain both endpoints", () => {
    const bad = cloneWorld();
    // Green runs through Central but not Harbor, so this edge cannot ride green.
    bad.stations
      .find((s: { id: string }) => s.id === "har")
      .connections.push({ to: "cen", line: "green", minutes: 3 });
    expect(() => parseWorld(bad)).toThrow(/does not contain both/);
  });

  it("throws when a line's ordered stations skip an edge", () => {
    const bad = cloneWorld();
    // Swap Market and Central in red's sequence, so Harbor now precedes Central,
    // a consecutive pair with no direct edge on red.
    bad.lines.find((l: { id: string }) => l.id === "red").stations = [
      "har",
      "cen",
      "mkt",
      "riv",
      "end",
    ];
    expect(() => parseWorld(bad)).toThrow(/no matching edge/);
  });

  it("throws on a site whose nearestStation does not resolve", () => {
    const bad = cloneWorld();
    bad.sites[0].nearestStation = "zzz";
    expect(() => parseWorld(bad)).toThrow(/nearestStation .*does not resolve/);
  });

  it("throws on a zonesPresent entry that names an unknown zone", () => {
    const bad = cloneWorld();
    bad.sites[0].zonesPresent.push("z9");
    expect(() => parseWorld(bad)).toThrow(/site .* names unknown zone/);
  });

  it("throws on a door that names a zone no world zone defines", () => {
    const bad = cloneWorld();
    // z9 is not a defined zone at all, distinct from a defined-but-not-present zone.
    bad.doors[0].zone = "z9";
    expect(() => parseWorld(bad)).toThrow(/door .* names unknown zone/);
  });

  it("throws on a zone trustLevel that is not an integer in [0, 4]", () => {
    const bad = cloneWorld();
    bad.zones[0].trustLevel = 2.5;
    expect(() => parseWorld(bad)).toThrow(/trustLevel must be an integer/);
  });

  it("throws on a zone id outside the ^z[0-4]$ domain", () => {
    const bad = cloneWorld();
    bad.zones[0].id = "z9";
    expect(() => parseWorld(bad)).toThrow(/zone id "z9" must match/);
  });

  it("throws on an unknown site type", () => {
    const bad = cloneWorld();
    bad.sites[0].type = "banana";
    expect(() => parseWorld(bad)).toThrow(/unknown type/);
  });

  it("throws on a control center whose type is not control-center", () => {
    const bad = cloneWorld();
    bad.controlCenter.type = "banana";
    expect(() => parseWorld(bad)).toThrow(/control-center/);
  });

  it("throws on a boxed Boolean where a primitive boolean is required", () => {
    const bad = cloneWorld();
    // A boxed Boolean would slip past a tag-only check; the guard rejects it.
    bad.lines[0].loop = new Boolean(true);
    expect(() => parseWorld(bad)).toThrow(/wrong type/);
  });
});

describe("world immutability", () => {
  it("is deeply frozen, so an actor cannot mutate the shared environment", () => {
    expect(Object.isFrozen(world)).toBe(true);
    expect(Object.isFrozen(world.zones)).toBe(true);
    expect(Object.isFrozen(world.stations)).toBe(true);
    const station = world.stations[0];
    expect(station !== undefined && Object.isFrozen(station)).toBe(true);
    expect(station !== undefined && Object.isFrozen(station.connections)).toBe(true);
  });
});

describe("zoneTrustLevel", () => {
  it("returns the zone's trust level", () => {
    expect(zoneTrustLevel("z0")).toBe(0);
    expect(zoneTrustLevel("z2")).toBe(2);
    expect(zoneTrustLevel("z4")).toBe(4);
  });

  it("throws on an unknown zone", () => {
    expect(() => zoneTrustLevel("z9")).toThrow(/unknown zone/);
  });
});

describe("doorGrade", () => {
  it("returns the door's zone trust level", () => {
    expect(doorGrade("dep", "STORE")).toBe(2);
    expect(doorGrade("dep", "YARD")).toBe(3);
    expect(doorGrade("sig", "CABIN")).toBe(3);
    expect(doorGrade("occ", "MAIN")).toBe(4);
  });

  it("throws on an unknown door", () => {
    expect(() => doorGrade("dep", "VAULT")).toThrow(/unknown door/);
    expect(() => doorGrade("nowhere", "MAIN")).toThrow(/unknown door/);
  });
});

describe("world singleton", () => {
  it("is the validated real world", () => {
    expect(world.stations.length).toBeGreaterThan(0);
    expect(world.doors.length).toBe(7);
  });
});
