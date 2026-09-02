import { describe, expect, it } from "vitest";
import {
  assertWorldConsistent,
  doorGrade,
  lineName,
  placeName,
  siteName,
  stationName,
  trainName,
  world,
  zoneName,
  zoneTrustLevel,
} from "./world";
import { worldData } from "./world.data";

/**
 * A fresh, mutable deep copy of the real world data. `JSON.parse` returns `any`,
 * so the result stays loosely typed and a test can mutate one invariant at a time;
 * `any` then assigns straight into `assertWorldConsistent`'s `World` parameter with
 * no cast, since a referential break is exactly what the compiler cannot catch.
 */
function cloneWorld() {
  return JSON.parse(JSON.stringify(worldData));
}

describe("assertWorldConsistent", () => {
  it("accepts the real world", () => {
    expect(() => assertWorldConsistent(world)).not.toThrow();
  });

  it("throws on a duplicate station id", () => {
    const bad = cloneWorld();
    bad.stations[1].id = bad.stations[0].id;
    expect(() => assertWorldConsistent(bad)).toThrow(/duplicate station id/);
  });

  it("throws on a location id that collides across stations and a site", () => {
    const bad = cloneWorld();
    bad.sites[0].id = bad.stations[0].id;
    expect(() => assertWorldConsistent(bad)).toThrow(/duplicate location id/);
  });

  it("throws on a non-reciprocal connection", () => {
    const bad = cloneWorld();
    // har <-> mkt on red is 3 minutes each way; drop mkt's edge back to har.
    const market = bad.stations.find((s: { id: string }) => s.id === "mkt");
    market.connections = market.connections.filter((c: { to: string }) => c.to !== "har");
    expect(() => assertWorldConsistent(bad)).toThrow(/reciprocal edge/);
  });

  it("throws on an unequal reciprocal weight", () => {
    const bad = cloneWorld();
    const market = bad.stations.find((s: { id: string }) => s.id === "mkt");
    const edge = market.connections.find((c: { to: string }) => c.to === "har");
    edge.minutes = 9;
    expect(() => assertWorldConsistent(bad)).toThrow(/unequal weights/);
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
    expect(() => assertWorldConsistent(bad)).toThrow(/non-positive travel time/);
  });

  it("throws on a non-finite travel time", () => {
    const bad = cloneWorld();
    for (const station of bad.stations) {
      for (const connection of station.connections) {
        if (
          (station.id === "har" && connection.to === "mkt") ||
          (station.id === "mkt" && connection.to === "har")
        ) {
          connection.minutes = Number.NaN;
        }
      }
    }
    expect(() => assertWorldConsistent(bad)).toThrow(/non-finite travel time/);
  });

  it("throws on a disconnected station graph", () => {
    const bad = cloneWorld();
    // Cut World's End off entirely, both directions, so the graph splits but every
    // remaining edge stays reciprocal. Only the connectivity check should fire.
    const end = bad.stations.find((s: { id: string }) => s.id === "end");
    end.connections = [];
    const riverside = bad.stations.find((s: { id: string }) => s.id === "riv");
    riverside.connections = riverside.connections.filter((c: { to: string }) => c.to !== "end");
    expect(() => assertWorldConsistent(bad)).toThrow(/not fully connected/);
  });

  it("throws on a door whose location does not resolve", () => {
    const bad = cloneWorld();
    bad.doors[0].location = "nowhere";
    expect(() => assertWorldConsistent(bad)).toThrow(/does not resolve for locationType/);
  });

  it("throws on a door zone not present at its location", () => {
    const bad = cloneWorld();
    // z4 exists but is not present at the depot site (dep has z2, z3 only).
    const store = bad.doors.find(
      (d: { location: string; name: string }) => d.location === "dep" && d.name === "STORE",
    );
    store.zone = "z4";
    expect(() => assertWorldConsistent(bad)).toThrow(/is not present at/);
  });

  it("throws on a duplicate door key", () => {
    const bad = cloneWorld();
    bad.doors.push({ location: "dep", locationType: "site", name: "STORE", zone: "z3" });
    expect(() => assertWorldConsistent(bad)).toThrow(/duplicate door key/);
  });

  it("throws on a duplicate zone id", () => {
    const bad = cloneWorld();
    bad.zones[1].id = bad.zones[0].id;
    expect(() => assertWorldConsistent(bad)).toThrow(/duplicate zone id/);
  });

  it("throws on a duplicate line id", () => {
    const bad = cloneWorld();
    bad.lines[1].id = bad.lines[0].id;
    expect(() => assertWorldConsistent(bad)).toThrow(/duplicate line id/);
  });

  it("throws on a duplicate site id", () => {
    const bad = cloneWorld();
    bad.sites[1].id = bad.sites[0].id;
    expect(() => assertWorldConsistent(bad)).toThrow(/duplicate site id/);
  });

  it("throws when a line and a station disagree on membership", () => {
    const bad = cloneWorld();
    // Red still names Harbor, but Harbor no longer names red.
    bad.stations.find((s: { id: string }) => s.id === "har").lines = [];
    expect(() => assertWorldConsistent(bad)).toThrow(/disagree on membership/);
  });

  it("throws on a connection to an unknown station", () => {
    const bad = cloneWorld();
    bad.stations.find((s: { id: string }) => s.id === "har").connections[0].to = "zzz";
    expect(() => assertWorldConsistent(bad)).toThrow(/connects to unknown station/);
  });

  it("throws on a connection whose line does not contain both endpoints", () => {
    const bad = cloneWorld();
    // Green runs through Central but not Harbor, so this edge cannot ride green.
    bad.stations
      .find((s: { id: string }) => s.id === "har")
      .connections.push({ to: "cen", line: "green", minutes: 3 });
    expect(() => assertWorldConsistent(bad)).toThrow(/does not contain both/);
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
    expect(() => assertWorldConsistent(bad)).toThrow(/no matching edge/);
  });

  it("throws on a site whose nearestStation does not resolve", () => {
    const bad = cloneWorld();
    bad.sites[0].nearestStation = "zzz";
    expect(() => assertWorldConsistent(bad)).toThrow(/nearestStation .*does not resolve/);
  });

  it("throws on a zonesPresent entry that names an unknown zone", () => {
    const bad = cloneWorld();
    bad.sites[0].zonesPresent.push("z9");
    expect(() => assertWorldConsistent(bad)).toThrow(/site .* names unknown zone/);
  });

  it("throws on a door that names a zone no world zone defines", () => {
    const bad = cloneWorld();
    // z9 is not a defined zone at all, distinct from a defined-but-not-present zone.
    bad.doors[0].zone = "z9";
    expect(() => assertWorldConsistent(bad)).toThrow(/door .* names unknown zone/);
  });

  it("throws on a zone trustLevel that is not an integer in [0, 4]", () => {
    const bad = cloneWorld();
    bad.zones[0].trustLevel = 2.5;
    expect(() => assertWorldConsistent(bad)).toThrow(/trustLevel must be an integer/);
  });

  it("throws on a zone id outside the ^z[0-4]$ domain", () => {
    const bad = cloneWorld();
    bad.zones[0].id = "z9";
    expect(() => assertWorldConsistent(bad)).toThrow(/zone id "z9" must match/);
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

describe("stationName", () => {
  it("returns the station's real name", () => {
    expect(stationName("cen")).toBe("Central");
    expect(stationName("riv")).toBe("Riverside");
  });

  it("throws on an unknown station", () => {
    expect(() => stationName("nope")).toThrow(/unknown station/);
  });
});

describe("siteName", () => {
  it("returns the site's real name", () => {
    expect(siteName("dep")).toBe("Eastyard Depot");
    expect(siteName("sub")).toBe("Riverside Substation");
  });

  it("throws on an unknown site", () => {
    expect(() => siteName("nope")).toThrow(/unknown site/);
  });
});

describe("lineName", () => {
  it("returns the line's real name", () => {
    expect(lineName("red")).toBe("Red Line");
    expect(lineName("circle")).toBe("Circle Line");
  });

  it("throws on an unknown line", () => {
    expect(() => lineName("purple")).toThrow(/unknown line/);
  });
});

describe("zoneName", () => {
  it("returns the zone's real name", () => {
    expect(zoneName("z0")).toBe("Public");
    expect(zoneName("z4")).toBe("Control");
  });

  it("throws on an unknown zone", () => {
    expect(() => zoneName("z9")).toThrow(/unknown zone/);
  });
});

describe("placeName", () => {
  it("resolves a station id", () => {
    expect(placeName("cen")).toBe("Central");
  });

  it("resolves a site id", () => {
    expect(placeName("dep")).toBe("Eastyard Depot");
  });

  it("resolves the control-center id", () => {
    expect(placeName("occ")).toBe("Operations Control Center");
  });

  it("falls back to the raw id when it names no place", () => {
    expect(placeName("nope")).toBe("nope");
  });
});

describe("trainName", () => {
  it("returns the train's line's authored trainName", () => {
    expect(trainName("T1")).toBe("Red Line train");
    expect(trainName("T2")).toBe("Blue Line train");
  });

  it("throws on an unknown train id", () => {
    expect(() => trainName("T9")).toThrow(/unknown train/);
  });
});
