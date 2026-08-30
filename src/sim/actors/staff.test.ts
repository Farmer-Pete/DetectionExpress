import { describe, expect, it } from "vitest";
import { GAME_SECONDS_PER_TICK } from "../../game/tuning";
import type { Badge } from "../entities/badge";
import { distanceTable } from "../world/distance";
import type { Presence } from "../world/presence";
import { buildTimetable } from "../world/timetable";
import { world, zoneTrustLevel } from "../world/world";
import type { DoorReaderReading, WorldEnv, WorldReading } from "../world-reading";
import { createSchedule } from "./actor";
import { createStaff, initialStaffPresence, type StaffConfig } from "./staff";

const env: WorldEnv = {
  world,
  distances: distanceTable(world),
  timetable: buildTimetable(world),
};

/** A door-reader payload, narrowed off the discriminated union. */
function grantOf(reading: WorldReading): DoorReaderReading {
  if (reading.sensor !== "door-reader") {
    throw new Error(`expected a door-reader reading, got "${reading.sensor}".`);
  }
  return reading.reading;
}

/** Step one staff to dormancy, collecting its grants and every presence in order. */
function runStaff(config: StaffConfig) {
  const schedule = createSchedule({ actors: [createStaff(config)], env, runSeed: 1 });
  const grants: DoorReaderReading[] = [];
  const presences: Presence[] = [];
  for (let tick = 0; tick < 1000; tick++) {
    const step = schedule.advanceTo(tick + 1);
    for (const timed of step.readings) {
      grants.push(grantOf(timed.reading));
    }
    const presence = step.presences.get(config.id);
    if (presence !== undefined) {
      presences.push(presence);
    }
    if (schedule.activeIds().length === 0 && tick > config.startTick) {
      break;
    }
  }
  return { grants, presences };
}

const DEP: StaffConfig = {
  id: "S900",
  badge: { id: "B900", grade: 4 },
  location: "dep",
  nearestStation: "jct",
  startTick: 0,
  walkTicks: 2,
  stepTicks: 3,
};

describe("createStaff", () => {
  it("crosses the location's zones low to high, one grant per eligible door in ascending zone order", () => {
    // Eastyard Depot has STORE (z2) and YARD (z3). A grade-4 badge opens both.
    const { grants } = runStaff(DEP);
    expect(grants.map((g) => ({ door: g.door, zone: g.zone, result: g.result }))).toEqual([
      { door: "STORE", zone: "z2", result: "grant" },
      { door: "YARD", zone: "z3", result: "grant" },
    ]);
    // The crossed zones are strictly ascending: it never jumps a zone.
    const trust = grants.map((g) => zoneTrustLevel(g.zone));
    for (let i = 1; i < trust.length; i++) {
      expect(trust[i]).toBeGreaterThan(trust[i - 1] ?? -1);
    }
  });

  it("stamps every grant with the badge, the visited site, and ts in game seconds", () => {
    const { grants } = runStaff(DEP);
    for (const grant of grants) {
      expect(grant.badge).toBe("B900");
      expect(grant.site).toBe("dep");
      expect(Number.isInteger(grant.ts / GAME_SECONDS_PER_TICK)).toBe(true);
    }
  });

  it("only ever opens doors that belong to the visited location", () => {
    const { grants } = runStaff({ ...DEP, location: "sub", nearestStation: "riv" });
    const subDoors = new Set(
      world.doors.filter((door) => door.location === "sub").map((door) => door.name),
    );
    expect(grants.length).toBeGreaterThan(0);
    for (const grant of grants) {
      expect(subDoors.has(grant.door)).toBe(true);
    }
  });

  it("never grants above the badge grade (a per-credential separability guard)", () => {
    // A grade-2 badge at Eastyard Depot may open STORE (z2) but never YARD (z3).
    const { grants } = runStaff({ ...DEP, badge: { id: "B210", grade: 2 } });
    expect(grants.map((g) => g.door)).toEqual(["STORE"]);
    for (const grant of grants) {
      expect(zoneTrustLevel(grant.zone)).toBeLessThanOrEqual(2);
    }
  });

  it("opens nothing when no door sits within the badge grade (walks in and out)", () => {
    // The Signal Cabin has only a z3 door; a grade-2 badge can open nothing there.
    const { grants, presences } = runStaff({
      ...DEP,
      badge: { id: "B211", grade: 2 },
      location: "sig",
      nearestStation: "jct",
    });
    expect(grants).toHaveLength(0);
    // It still walks in and out: a moving-in, then a moving-out presence.
    expect(presences.filter((p) => p.kind === "moving")).toHaveLength(2);
  });

  it("moves in from the nearest station, works at the site, then moves back out", () => {
    const { presences } = runStaff(DEP);
    const walkIn = presences[0];
    expect(walkIn?.kind).toBe("moving");
    if (walkIn?.kind === "moving") {
      expect(walkIn.from).toBe("jct");
      expect(walkIn.to).toBe("dep");
    }
    // While working it is `at` the site.
    expect(presences.some((p) => p.kind === "at" && p.node === "dep")).toBe(true);
    // The last presence is the walk back out, site -> station.
    const walkOut = presences.at(-1);
    expect(walkOut?.kind).toBe("moving");
    if (walkOut?.kind === "moving") {
      expect(walkOut.from).toBe("dep");
      expect(walkOut.to).toBe("jct");
    }
  });

  it("crosses OCC's three zones in order (OFFICE z2, OPS z3, MAIN z4)", () => {
    const { grants } = runStaff({
      ...DEP,
      badge: { id: "B4", grade: 4 },
      location: "occ",
      nearestStation: "cen",
    });
    expect(grants.map((g) => g.door)).toEqual(["OFFICE", "OPS", "MAIN"]);
  });
});

describe("initialStaffPresence", () => {
  it("stands the staff at its nearest station until its first tick", () => {
    const badge: Badge = { id: "B1", grade: 3 };
    expect(initialStaffPresence("jct", 12)).toEqual({
      kind: "at",
      node: "jct",
      fromTick: 12,
      untilTick: 12,
    });
    expect(badge.grade).toBe(3);
  });
});
