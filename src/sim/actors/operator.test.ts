import { describe, expect, it } from "vitest";
import { GAME_SECONDS_PER_TICK } from "../../game/tuning";
import { controlReference } from "../entities/control";
import { distanceTable } from "../world/distance";
import { buildTimetable } from "../world/timetable";
import { world } from "../world/world";
import type { ConsoleReading, WorldEnv, WorldReading } from "../world-reading";
import { createSchedule } from "./actor";
import { createOperator, initialOperatorPresence, type OperatorConfig } from "./operator";

const env: WorldEnv = {
  world,
  distances: distanceTable(world),
  timetable: buildTimetable(world),
  control: controlReference,
};

const OCC = world.controlCenter.id;

const CONFIG: OperatorConfig = {
  id: "OP1",
  node: OCC,
  console: controlReference.consoles[2] ?? { operator: "green.disp", host: "OCC-3" },
  startTick: 0,
  cadenceTicks: 30,
};

/** A console payload, narrowed off the discriminated union. */
function consoleOf(reading: WorldReading): ConsoleReading {
  if (reading.sensor !== "occ-console") {
    throw new Error(`expected an occ-console reading, got "${reading.sensor}".`);
  }
  return reading.reading;
}

/** Step one operator to a horizon, collecting its console readings and presences. */
function runOperator(config: OperatorConfig, horizon: number) {
  const schedule = createSchedule({ actors: [createOperator(config)], env, runSeed: 7 });
  const readings: { tick: number; reading: ConsoleReading }[] = [];
  const presences = [];
  for (let tick = 0; tick < horizon; tick++) {
    const step = schedule.advanceTo(tick + 1);
    for (const timed of step.readings) {
      readings.push({ tick, reading: consoleOf(timed.reading) });
    }
    const presence = step.presences.get(config.id);
    if (presence !== undefined) {
      presences.push({ tick, presence });
    }
  }
  return { readings, presences, schedule };
}

describe("createOperator", () => {
  it("issues a benign command from its authorized console, in the occ-console shape", () => {
    const { readings } = runOperator(CONFIG, 200);
    expect(readings.length).toBeGreaterThan(0);
    const commandKeys = new Set(controlReference.commands.map((c) => `${c.command}|${c.target}`));
    for (const { reading } of readings) {
      // The exact field set from the sensor data: ts, operator, host, command, target.
      expect(Object.keys(reading).sort()).toEqual(
        ["command", "host", "operator", "target", "ts"].sort(),
      );
      // The operator and console are the authorized ones from the reference set.
      expect(reading.operator).toBe(CONFIG.console.operator);
      expect(reading.host).toBe(CONFIG.console.host);
      // The command/target pair is drawn from the authorized benign set, never invented.
      expect(commandKeys.has(`${reading.command}|${reading.target}`)).toBe(true);
    }
  });

  it("stamps ts in the game-second domain and fires at its cadence", () => {
    const { readings } = runOperator({ ...CONFIG, startTick: 5, cadenceTicks: 30 }, 200);
    const ticks = readings.map((entry) => entry.tick);
    expect(ticks.slice(0, 3)).toEqual([5, 35, 65]);
    for (const entry of readings) {
      expect(entry.reading.ts).toBe(entry.tick * GAME_SECONDS_PER_TICK);
    }
  });

  it("is deterministic: the same seed reproduces the same command stream", () => {
    const a = runOperator(CONFIG, 200).readings.map(
      (e) => `${e.reading.command}|${e.reading.target}`,
    );
    const b = runOperator(CONFIG, 200).readings.map(
      (e) => `${e.reading.command}|${e.reading.target}`,
    );
    expect(a).toEqual(b);
  });

  it("is a persistent fixture: never dormant, always seated at the OCC (a fixed node)", () => {
    const { presences, schedule } = runOperator(CONFIG, 500);
    // It never goes dormant over a long run, so the schedule keeps its record.
    expect(schedule.activeIds()).toContain(CONFIG.id);
    // Every presence is `at` the OCC node; it never moves.
    for (const { presence } of presences) {
      expect(presence.kind).toBe("at");
      if (presence.kind === "at") {
        expect(presence.node).toBe(OCC);
      }
    }
  });

  it("seeds its initial presence seated at the OCC until its first command", () => {
    expect(initialOperatorPresence(OCC, 40)).toEqual({
      kind: "at",
      node: OCC,
      fromTick: 0,
      untilTick: 40,
    });
  });

  it("appears in the schedule's initial ticks (present from the start)", () => {
    const schedule = createSchedule({ actors: [createOperator(CONFIG)], env, runSeed: 7 });
    expect(schedule.initialTicks().get(CONFIG.id)).toBe(CONFIG.startTick);
  });
});
