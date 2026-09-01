import { describe, expect, it } from "vitest";
import { controlReference } from "../sim/entities/control";
import { buildTimetable } from "../sim/world/timetable";
import { world } from "../sim/world/world";
import { buildAmbientFixtures } from "./ambient-cast";
import { CONTROL_LAUNCH_PHASE_TICKS } from "./tuning";

// Ported from world-control.test.ts's "world run controller seeds the M6 control cast"
// (GH117-PLAN.md), ahead of that file's deletion. `buildAmbientFixtures` is the pure
// function under test there; this exercises it directly instead of through the retired
// `world-run-controller`.

const timetable = buildTimetable(world);

describe("buildAmbientFixtures", () => {
  it("seeds one operator per console and one host per site host, alongside the trains", () => {
    const fixtures = buildAmbientFixtures(world, timetable);
    const operators = fixtures.filter((fixture) => fixture.kind === "operator");
    const hosts = fixtures.filter((fixture) => fixture.kind === "host");
    expect(operators).toHaveLength(controlReference.consoles.length);
    expect(hosts).toHaveLength(controlReference.hosts.length);
    // Distinct ids that never collide with each other or the trains.
    const ids = fixtures.map((fixture) => fixture.actor.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(operators.map((fixture) => fixture.actor.id)).toEqual(["OP1", "OP2", "OP3"]);
  });

  it("phases the operator fixtures so they do not all first act on the same tick", () => {
    const fixtures = buildAmbientFixtures(world, timetable);
    // Each operator's first tick is its per-index launch phase, so they stagger.
    const starts = fixtures
      .filter((fixture) => fixture.kind === "operator")
      .map((fixture) => fixture.actor.start({ rng: () => 0 }));
    expect(starts).toEqual([0, CONTROL_LAUNCH_PHASE_TICKS, 2 * CONTROL_LAUNCH_PHASE_TICKS]);
  });

  it("builds one persistent train per line", () => {
    const fixtures = buildAmbientFixtures(world, timetable);
    const trains = fixtures.filter((fixture) => fixture.kind === "train");
    expect(trains).toHaveLength(world.lines.length);
  });
});
