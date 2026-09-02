/**
 * Tests for the baseline cast (GH126-PLAN.md M1, "Baseline-cast builder", seam 4):
 * the calm endless metro's WorldEnv, ambient cast, empty scenario members, kiosk
 * `toEvent` adapter, and never-closing scored ingress. Also covers seam 3 (the
 * checkpoint loop is inert with no checkpoints) and seam 5 (account-rider
 * admissions score; rider/staff admissions stay ambient) for a full baseline run.
 */
import { describe, expect, it } from "vitest";
import { createScorer, type ScorerConfig } from "../sim/correctness";
import { isRawKioskV1 } from "../sim/endpoints/kiosk/formats/kiosk-v1";
import type { SimSnapshot } from "../sim/snapshot";
import type { TaskAlgorithm } from "../sim/tasks";
import { buildBaselineCast } from "./baseline-cast";
import { ManualDriver } from "./clock";
import { type CheckpointObservation, type StartOptions, start } from "./engine";
import { getGraph } from "./store";
import { CORRECTNESS_W_FN, CORRECTNESS_W_FP, CORRECTNESS_WINDOW } from "./tuning";

const SCORER_CONFIG: ScorerConfig = {
  window: CORRECTNESS_WINDOW,
  wFn: CORRECTNESS_W_FN,
  wFp: CORRECTNESS_W_FP,
};

/** normalize is identity, detect never fires: nothing raises, nothing scores. */
const idleAlgorithm: TaskAlgorithm = {
  normalize: (raw) => raw,
  detect: () => [],
};

async function flush(rounds: number): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
}

async function step(driver: ManualDriver, ticks: number, flushRounds = 50): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    driver.tick();
    await flush(flushRounds);
  }
}

const SEED = 1234;

describe("buildBaselineCast", () => {
  it("carries an empty scenario member list: no Attack, nothing scenario-specific to step", () => {
    const { scenarioCast } = buildBaselineCast(SEED);
    expect(scenarioCast.members).toEqual([]);
    expect(scenarioCast.runSeed).toBe(SEED);
  });

  it("carries the metro's ambient life: fixtures and all three spawners", () => {
    const { ambientCast } = buildBaselineCast(SEED);
    expect(ambientCast.fixtures.length).toBeGreaterThan(0);
    expect(ambientCast.spawner).toBeDefined();
    expect(ambientCast.staffSpawner).toBeDefined();
    expect(ambientCast.accountSpawner).toBeDefined();
  });

  it("never closes: lastScoredTick is Infinity", () => {
    const { scoredIngest } = buildBaselineCast(SEED);
    expect(scoredIngest.lastScoredTick).toBe(Number.POSITIVE_INFINITY);
  });

  it("is deterministic for a seed: two builds carry the same ambient fixture and spawner shape", () => {
    const a = buildBaselineCast(SEED);
    const b = buildBaselineCast(SEED);
    expect(a.ambientCast.fixtures.map((f) => f.actor.id)).toEqual(
      b.ambientCast.fixtures.map((f) => f.actor.id),
    );
  });

  it("toEvent formats a kiosk reading through the kiosk-v1 endpoint, id-assigned by the caller", () => {
    const { scoredIngest } = buildBaselineCast(SEED);
    const timed = {
      reading: {
        sensor: "kiosk" as const,
        reading: {
          ts: 5,
          account: "river.k",
          station: "cen",
          terminal: "K1",
          outcome: "success" as const,
        },
      },
      actorId: "A000000",
      tick: 5,
    };
    const event = scoredIngest.toEvent(timed, 7);
    expect(event.id).toBe(7);
    expect(event.ts).toBe(5);
    expect(event.endpoint).toBe("kiosk-v1");
    expect(isRawKioskV1(event.payload)).toBe(true);
  });
});

describe("engine + baseline cast: the endless calm run (GH126-PLAN.md M1, seams 3, 4, 5)", () => {
  function launchBaseline(onCheckpoint?: (o: CheckpointObservation) => void) {
    const driver = new ManualDriver();
    const { scenarioCast, ambientCast, scoredIngest } = buildBaselineCast(SEED);
    const options: StartOptions = {
      getGraph,
      setSnapshot: () => undefined,
      algorithm: idleAlgorithm,
      scorer: createScorer([], SCORER_CONFIG),
      generator: () => null,
      serviceRate: { num: 1_000_000, den: 1 },
      checkpoints: [],
      waves: [],
      scheduleMode: "endless",
      scenarioCast,
      ambientCast,
      scoredIngest,
      driver,
      ...(onCheckpoint ? { onCheckpoint } : {}),
    };
    const handle = start(options);
    return { handle, driver };
  }

  it("starts under the unchanged start() guard: scoredIngest + an empty-member scenarioCast is accepted", () => {
    const { handle } = launchBaseline();
    handle.stop();
  });

  it("never reaches a checkpoint: the checkpoint loop is inert with an empty checkpoint list (seam 3)", async () => {
    const observations: CheckpointObservation[] = [];
    const { handle, driver } = launchBaseline((o) => observations.push(o));
    await step(driver, 300, 30);
    expect(observations).toEqual([]);
    handle.stop();
    await handle.whenStopped;
  });

  it("keeps running well past where any bounded run would have concluded, never won or failed", async () => {
    const snapshots: SimSnapshot[] = [];
    const driver = new ManualDriver();
    const { scenarioCast, ambientCast, scoredIngest } = buildBaselineCast(SEED);
    const handle = start({
      getGraph,
      setSnapshot: (s) => snapshots.push(s),
      algorithm: idleAlgorithm,
      scorer: createScorer([], SCORER_CONFIG),
      generator: () => null,
      serviceRate: { num: 1_000_000, den: 1 },
      checkpoints: [],
      waves: [],
      scheduleMode: "endless",
      scenarioCast,
      ambientCast,
      scoredIngest,
      driver,
    });
    await step(driver, 300, 30);
    expect(snapshots.at(-1)?.status).toBe("running");
    handle.stop();
    await handle.whenStopped;
  });

  it("scores account-rider kiosk readings (admits scored Events) over a perpetual run", async () => {
    const snapshots: SimSnapshot[] = [];
    const driver = new ManualDriver();
    const { scenarioCast, ambientCast, scoredIngest } = buildBaselineCast(SEED);
    const handle = start({
      getGraph,
      setSnapshot: (s) => snapshots.push(s),
      algorithm: idleAlgorithm,
      scorer: createScorer([], SCORER_CONFIG),
      generator: () => null,
      serviceRate: { num: 1_000_000, den: 1 },
      checkpoints: [],
      waves: [],
      scheduleMode: "endless",
      scenarioCast,
      ambientCast,
      scoredIngest,
      driver,
    });
    await step(driver, 120, 30);
    expect(snapshots.at(-1)?.admitted).toBeGreaterThan(0);
    handle.stop();
    await handle.whenStopped;
  });

  it("tags a live account-rider actor scored-scenario and a live plain rider ambient (seam 5)", async () => {
    const snapshots: SimSnapshot[] = [];
    const driver = new ManualDriver();
    const { scenarioCast, ambientCast, scoredIngest } = buildBaselineCast(SEED);
    const handle = start({
      getGraph,
      setSnapshot: (s) => snapshots.push(s),
      algorithm: idleAlgorithm,
      scorer: createScorer([], SCORER_CONFIG),
      generator: () => null,
      serviceRate: { num: 1_000_000, den: 1 },
      checkpoints: [],
      waves: [],
      scheduleMode: "endless",
      scenarioCast,
      ambientCast,
      scoredIngest,
      driver,
    });
    await step(driver, 120, 30);
    const actors = snapshots.flatMap((s) => s.actors);
    const accountRiders = actors.filter((a) => a.kind === "account-rider");
    const plainRiders = actors.filter((a) => a.kind === "rider");
    expect(accountRiders.length).toBeGreaterThan(0);
    expect(plainRiders.length).toBeGreaterThan(0);
    expect(accountRiders.every((a) => a.provenance === "scored-scenario")).toBe(true);
    expect(plainRiders.every((a) => a.provenance === "ambient")).toBe(true);
    handle.stop();
    await handle.whenStopped;
  });

  it("always publishes a calm wave reading under endless mode, never incoming or active", async () => {
    const snapshots: SimSnapshot[] = [];
    const driver = new ManualDriver();
    const { scenarioCast, ambientCast, scoredIngest } = buildBaselineCast(SEED);
    const handle = start({
      getGraph,
      setSnapshot: (s) => snapshots.push(s),
      algorithm: idleAlgorithm,
      scorer: createScorer([], SCORER_CONFIG),
      generator: () => null,
      serviceRate: { num: 1_000_000, den: 1 },
      checkpoints: [],
      waves: [],
      scheduleMode: "endless",
      scenarioCast,
      ambientCast,
      scoredIngest,
      driver,
    });
    await step(driver, 90, 30);
    expect(snapshots.at(-1)?.wave).toEqual({
      phase: "calm",
      index: null,
      ticksUntilNext: null,
      eventsPerTick: null,
    });
    handle.stop();
    await handle.whenStopped;
  });
});
