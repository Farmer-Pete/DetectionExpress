import { describe, expect, it } from "vitest";
import { createHost, initialHostPresence } from "../sim/actors/host";
import { createOperator, initialOperatorPresence } from "../sim/actors/operator";
import { controlReference } from "../sim/entities/control";
import { distanceTable } from "../sim/world/distance";
import { consoleNodeId, relayNodeId } from "../sim/world/layout";
import { buildTimetable } from "../sim/world/timetable";
import { world } from "../sim/world/world";
import type { WorldEnv } from "../sim/world-reading";
import type { WorldSnapshot } from "../sim/world-snapshot";
import { ManualDriver } from "./clock";
import { CONTROL_LAUNCH_PHASE_TICKS, HOST_RELAY_TICKS, OPERATOR_COMMAND_TICKS } from "./tuning";
import { startWorld, type WorldEngineHandle, type WorldFixture } from "./world-engine";
import { createWorldRunController, type WorldRunControllerDeps } from "./world-run-controller";

const env: WorldEnv = {
  world,
  distances: distanceTable(world),
  timetable: buildTimetable(world),
  control: controlReference,
};

const OCC = world.controlCenter.id;
const noVisibility = (): (() => void) => () => undefined;

/** A persistent operator fixture at the OCC, and a host fixture at a site. */
function controlFixtures(): WorldFixture[] {
  return [
    {
      actor: createOperator({
        id: "OP1",
        node: OCC,
        console: controlReference.consoles[0] ?? { operator: "red.disp", host: "OCC-1" },
        startTick: 0,
        cadenceTicks: OPERATOR_COMMAND_TICKS,
      }),
      kind: "operator",
      initialPresence: (firstTick) => initialOperatorPresence(OCC, firstTick),
    },
    {
      actor: createHost({
        id: "H1",
        site: "dep",
        host: "YARD-NET-1",
        startTick: 0,
        cadenceTicks: HOST_RELAY_TICKS,
      }),
      kind: "host",
      initialPresence: (firstTick) => initialHostPresence("dep", firstTick),
    },
  ];
}

function drive(fixtures: WorldFixture[], ticks: number): WorldSnapshot {
  let latest: WorldSnapshot | null = null;
  const driver = new ManualDriver();
  const handle = startWorld({
    fixtures,
    env,
    runSeed: 3,
    setWorldSnapshot: (snapshot) => {
      latest = snapshot;
    },
    driver,
    bindVisibility: noVisibility,
  });
  for (let i = 0; i < ticks; i++) {
    driver.tick();
  }
  handle.stop();
  if (latest === null) {
    throw new Error("no snapshot was published.");
  }
  return latest;
}

describe("world engine folds the M6 control cast", () => {
  it("raises a command flash on the OCC console chip and logs the occ-console reading", () => {
    const snapshot = drive(controlFixtures(), 40);
    expect(snapshot.flashes.some((flash) => flash.kind === "command")).toBe(true);
    const commandFlash = snapshot.flashes.find((flash) => flash.kind === "command");
    expect(commandFlash?.node).toBe(consoleNodeId(OCC));
    const consoleLog = snapshot.log.find((entry) => entry.reading.sensor === "occ-console");
    expect(consoleLog).toBeDefined();
  });

  it("raises a packet flash on the site relay chip and logs the network-relay reading", () => {
    const snapshot = drive(controlFixtures(), 40);
    expect(snapshot.flashes.some((flash) => flash.kind === "packet")).toBe(true);
    const packetFlash = snapshot.flashes.find((flash) => flash.kind === "packet");
    expect(packetFlash?.node).toBe(relayNodeId("dep"));
    const relayLog = snapshot.log.find((entry) => entry.reading.sensor === "network-relay");
    expect(relayLog).toBeDefined();
  });

  it("keeps the operator and host present the whole run (never evicted)", () => {
    const snapshot = drive(controlFixtures(), 600);
    const kinds = snapshot.actors.map((actor) => actor.kind);
    expect(kinds).toContain("operator");
    expect(kinds).toContain("host");
  });
});

const distances = distanceTable(world);

function fakeHandle(): WorldEngineHandle {
  return { stop: () => undefined, whenStopped: Promise.resolve() };
}

function baseDeps(over: Partial<WorldRunControllerDeps>): WorldRunControllerDeps {
  return {
    world,
    distances,
    getFixtures: () => [],
    getSeed: () => 1,
    setWorldSnapshot: () => undefined,
    start: () => fakeHandle(),
    ...over,
  };
}

describe("world run controller seeds the M6 control cast", () => {
  it("seeds one operator per console and one host per site host, alongside the trains", () => {
    let fixtures: readonly WorldFixture[] = [];
    const controller = createWorldRunController(
      baseDeps({
        start: (options) => {
          fixtures = options.fixtures;
          return fakeHandle();
        },
      }),
    );
    controller.run();
    const operators = fixtures.filter((fixture) => fixture.kind === "operator");
    const hosts = fixtures.filter((fixture) => fixture.kind === "host");
    expect(operators).toHaveLength(controlReference.consoles.length);
    expect(hosts).toHaveLength(controlReference.hosts.length);
    // Distinct ids that never collide with the trains T1..T4.
    const ids = fixtures.map((fixture) => fixture.actor.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(operators.map((fixture) => fixture.actor.id)).toEqual(["OP1", "OP2", "OP3"]);
  });

  it("stashes the control reference in the env the engine reads", () => {
    let seenControl: WorldEnv["control"];
    const controller = createWorldRunController(
      baseDeps({
        start: (options) => {
          seenControl = options.env.control;
          return fakeHandle();
        },
      }),
    );
    controller.run();
    expect(seenControl).toBe(controlReference);
  });

  it("phases the operator fixtures so they do not all first act on the same tick", () => {
    let fixtures: readonly WorldFixture[] = [];
    const controller = createWorldRunController(
      baseDeps({
        start: (options) => {
          fixtures = options.fixtures;
          return fakeHandle();
        },
      }),
    );
    controller.run();
    // Each operator's first tick is its per-index launch phase, so they stagger.
    const starts = fixtures
      .filter((fixture) => fixture.kind === "operator")
      .map((fixture) => fixture.actor.start({ rng: () => 0 }));
    expect(starts).toEqual([0, CONTROL_LAUNCH_PHASE_TICKS, 2 * CONTROL_LAUNCH_PHASE_TICKS]);
  });
});
