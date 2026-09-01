import { describe, expect, it } from "vitest";
import { createAccountRider, initialAccountRiderPresence } from "../sim/actors/account-rider";
import type { AccountRiderSpawner } from "../sim/actors/account-rider-spawner";
import type { Actor } from "../sim/actors/actor";
import { createHost, initialHostPresence } from "../sim/actors/host";
import { createOperator, initialOperatorPresence } from "../sim/actors/operator";
import type { RiderTripConfig } from "../sim/actors/rider-core";
import type { RiderSpawner } from "../sim/actors/rider-spawner";
import { createWorldRider, initialRiderPresence } from "../sim/actors/world-rider";
import type { Attack } from "../sim/attack";
import {
  createScorer,
  type Decision,
  type MissedDecision,
  type Scorer,
  type ScorerConfig,
} from "../sim/correctness";
import { isRawKioskV1 } from "../sim/endpoints/kiosk/formats/kiosk-v1";
import { controlReference } from "../sim/entities/control";
import type { PipeEvent } from "../sim/event";
import { RuleError } from "../sim/rule-error";
import type { Checkpoint, Wave } from "../sim/scenario";
import {
  createPinAttacker,
  initialPinAttackerPresence,
} from "../sim/scenarios/pin-brute-force/pin-attacker";
import { buildReferenceAlgorithm } from "../sim/scenarios/pin-brute-force/reference";
import { buildBlueprint, pinBruteForce } from "../sim/scenarios/pin-brute-force/scenario";
import { PIN_BRUTE_FORCE_THRESHOLD } from "../sim/scenarios/pin-brute-force/tuning";
import type { ServiceRate } from "../sim/service-governor";
import { emptySnapshot, type SimSnapshot } from "../sim/snapshot";
import type { TaskAlgorithm } from "../sim/tasks";
import { distanceTable } from "../sim/world/distance";
import { consoleNodeId, kioskNodeId, relayNodeId } from "../sim/world/layout";
import type { Presence } from "../sim/world/presence";
import { buildTimetable } from "../sim/world/timetable";
import { world } from "../sim/world/world";
import type { WorldEnv, WorldReading } from "../sim/world-reading";
import { buildAmbientFixtures, buildAmbientSpawners } from "./ambient-cast";
import { ManualDriver, type TickDriver } from "./clock";
import {
  type AmbientCast,
  type AmbientFixture,
  type ScenarioCast,
  type ScenarioCastMember,
  type StartOptions,
  start,
} from "./engine";
import { getGraph } from "./store";
import {
  CHANNEL_CAP,
  CLOCK_HZ,
  CORRECTNESS_W_FN,
  CORRECTNESS_W_FP,
  CORRECTNESS_WINDOW,
  FLASH_WINDOW_TICKS,
  GAME_SECONDS_PER_TICK,
  HOST_RELAY_TICKS,
  LEVEL_SEED,
  OPERATOR_COMMAND_TICKS,
  RIDER_GOHOME_DWELL_TICKS,
  WAVE_WARN_TICKS,
} from "./tuning";

const SCORER_CONFIG: ScorerConfig = {
  window: CORRECTNESS_WINDOW,
  wFn: CORRECTNESS_W_FN,
  wFp: CORRECTNESS_W_FP,
};

/** A rate so fast the governor never sleeps: the pipeline drains as fast as it fills. */
const FAST_RATE: ServiceRate = { num: 1_000_000, den: 1 };

/** normalize is identity, detect never fires: the pipeline runs, nothing scores. */
const idleAlgorithm: TaskAlgorithm = {
  normalize: (raw) => raw,
  detect: () => [],
};

/** A single final deadline at `atTick`. */
function deadlineAt(atTick: number): Checkpoint[] {
  return [{ atTick, clearsThroughWave: 0 }];
}

async function flush(rounds: number): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
}

/**
 * Advance the Clock `ticks` ticks, draining microtasks between each. `flushRounds`
 * bounds the per-tick microtask drain; a high-volume run (many arrivals per tick)
 * needs more rounds to move every Event through the chain within its tick.
 */
async function step(driver: ManualDriver, ticks: number, flushRounds = 50): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    driver.tick();
    await flush(flushRounds);
  }
}

function ev(id: number, ts: number, payload: unknown = { acct: "x" }): PipeEvent {
  return { id, ts, endpoint: "kiosk-v1", payload };
}

/** The normalized record the reference detect reads, after Normalize runs. */
interface ReferenceView {
  account: string;
  terminal: string;
  outcome: "success" | "fail";
  id: number;
  ts: number;
  endpoint: string;
}

function isReferenceView(value: unknown): value is ReferenceView {
  return value instanceof Object && "account" in value && "outcome" in value && "id" in value;
}

/** A finite source: yields the given Events, then null (Ingest closes it). */
function scheduleOf(events: PipeEvent[]): () => PipeEvent | null {
  let i = 0;
  return () => (i < events.length ? (events[i++] ?? null) : null);
}

interface LaunchOpts {
  generator?: () => PipeEvent | null;
  algorithm?: TaskAlgorithm;
  scorer?: Scorer;
  setSnapshot?: (snapshot: SimSnapshot) => void;
  onError?: (error: unknown) => void;
  serviceRate?: ServiceRate;
  checkpoints?: Checkpoint[];
  waves?: Wave[];
  scenarioCast?: ScenarioCast;
  ambientCast?: AmbientCast;
}

interface Harness {
  handle: ReturnType<typeof start>;
  driver: ManualDriver;
  snapshots: SimSnapshot[];
  last: () => SimSnapshot | undefined;
}

function launch(opts: LaunchOpts): Harness {
  const driver = new ManualDriver();
  const snapshots: SimSnapshot[] = [];
  const options: StartOptions = {
    getGraph,
    setSnapshot: opts.setSnapshot ?? ((snapshot) => snapshots.push(snapshot)),
    algorithm: opts.algorithm ?? idleAlgorithm,
    scorer: opts.scorer ?? createScorer([], SCORER_CONFIG),
    generator: opts.generator ?? scheduleOf([]),
    serviceRate: opts.serviceRate ?? FAST_RATE,
    checkpoints: opts.checkpoints ?? [],
    waves: opts.waves ?? [],
    driver,
    ...(opts.scenarioCast ? { scenarioCast: opts.scenarioCast } : {}),
    ...(opts.ambientCast ? { ambientCast: opts.ambientCast } : {}),
    ...(opts.onError ? { onError: opts.onError } : {}),
  };
  const handle = start(options);
  return { handle, driver, snapshots, last: () => snapshots.at(-1) };
}

/** A driver that records whether the Clock ever started it. */
class SpyDriver implements TickDriver {
  started = false;
  stopped = false;
  start(): void {
    this.started = true;
  }
  stop(): void {
    this.stopped = true;
  }
  setRate(): void {}
}

describe("engine start guards", () => {
  it("throws on an invalid graph and allocates nothing", () => {
    const driver = new SpyDriver();
    expect(() =>
      start({
        getGraph: () => ({ nodes: [{ id: "x", kind: "bogus" }], edges: [] }),
        setSnapshot: () => undefined,
        algorithm: idleAlgorithm,
        scorer: createScorer([], SCORER_CONFIG),
        generator: scheduleOf([]),
        serviceRate: FAST_RATE,
        checkpoints: [],
        waves: [],
        driver,
      }),
    ).toThrow(/unknown/i);
    expect(driver.started).toBe(false); // the Clock was never constructed
  });

  it("throws on an unsorted wave schedule and allocates nothing (F003 hardening)", () => {
    const driver = new SpyDriver();
    const waves: Wave[] = [
      { startTick: 20, durationTicks: 5, eventsPerTick: 1 },
      { startTick: 0, durationTicks: 5, eventsPerTick: 1 },
    ];
    expect(() =>
      start({
        getGraph,
        setSnapshot: () => undefined,
        algorithm: idleAlgorithm,
        scorer: createScorer([], SCORER_CONFIG),
        generator: scheduleOf([]),
        serviceRate: FAST_RATE,
        checkpoints: [],
        waves,
        driver,
      }),
    ).toThrow();
    expect(driver.started).toBe(false); // the Clock was never constructed
  });

  it("throws on a NaN-startTick wave and allocates nothing (F002)", () => {
    const driver = new SpyDriver();
    const waves: Wave[] = [{ startTick: Number.NaN, durationTicks: 5, eventsPerTick: 1 }];
    expect(() =>
      start({
        getGraph,
        setSnapshot: () => undefined,
        algorithm: idleAlgorithm,
        scorer: createScorer([], SCORER_CONFIG),
        generator: scheduleOf([]),
        serviceRate: FAST_RATE,
        checkpoints: [],
        waves,
        driver,
      }),
    ).toThrow();
    expect(driver.started).toBe(false); // the Clock was never constructed
  });

  it("tears down the clock and publishes nothing when setup throws after the clock is built", () => {
    // The Clock is constructed and starts the driver, then reading the scorer during
    // runtime wiring throws. This exercises start()'s post-construction catch, which must
    // stop the driver (through clock.stop) and leave no snapshot published.
    const driver = new SpyDriver();
    const snapshots: SimSnapshot[] = [];
    const boom = new Error("setup boom after clock");
    expect(() =>
      start({
        getGraph,
        setSnapshot: (snapshot) => snapshots.push(snapshot),
        algorithm: idleAlgorithm,
        get scorer(): Scorer {
          throw boom;
        },
        generator: scheduleOf([]),
        serviceRate: FAST_RATE,
        checkpoints: [],
        waves: [],
        driver,
      }),
    ).toThrow(boom);
    expect(driver.started).toBe(true); // the Clock was constructed and started the driver
    expect(driver.stopped).toBe(true); // the post-construction catch tore the clock down
    expect(snapshots).toHaveLength(0); // no snapshot ever reached the sink
  });
});

// Adapt the reference twin (typed to its concrete records) to the engine's
// untyped TaskAlgorithm, narrowing at the boundary. The engine feeds it kiosk-v1
// payloads, and Normalize produces the record the reference detect expects.
function referenceTaskAlgorithm(): TaskAlgorithm {
  const algo = buildReferenceAlgorithm();
  return {
    normalize: (raw) => (isRawKioskV1(raw) ? algo.normalize(raw) : raw),
    detect: (view) => (isReferenceView(view) ? algo.detect(view) : []),
  };
}

describe("engine integration with the reference Algorithm", () => {
  function runReference(): { harness: Harness; finalTick: number } {
    const run = pinBruteForce.generate(LEVEL_SEED);
    const finalTick = run.checkpoints[run.checkpoints.length - 1]?.atTick ?? 0;
    const harness = launch({
      generator: scheduleOf(run.events),
      algorithm: referenceTaskAlgorithm(),
      scorer: createScorer(run.attacks, SCORER_CONFIG),
      checkpoints: run.checkpoints,
    });
    return { harness, finalTick };
  }

  it("wins at the final deadline with full Correctness and every Attack caught", async () => {
    const run = pinBruteForce.generate(LEVEL_SEED);
    const { harness, finalTick } = runReference();
    await step(harness.driver, finalTick + 2, 300);
    await harness.handle.whenStopped;
    const snap = harness.last();
    expect(snap).toBeDefined();
    if (!snap) return;
    expect(snap.status).toBe("won");
    expect(snap.failureReason).toBeNull();
    expect(snap.correctness.caught).toBe(run.attacks.length);
    expect(snap.correctness.missed).toBe(0);
    expect(snap.correctness.falseAlerts).toBe(0);
    expect(snap.correctness.rolling).toBe(100);
  });

  it("drains the Queue and completes every admitted Event at the win", async () => {
    const { harness, finalTick } = runReference();
    await step(harness.driver, finalTick + 2, 300);
    await harness.handle.whenStopped;
    const snap = harness.last();
    expect(snap).toBeDefined();
    if (!snap) return;
    expect(snap.queued).toBe(0); // sum of all channels, drained by the deadline
    expect(snap.admitted).toBe(snap.completed); // every admitted Event completed
  });

  it("produces the same final snapshot when run twice", async () => {
    const first = runReference();
    await step(first.harness.driver, first.finalTick + 2, 300);
    await first.harness.handle.whenStopped;
    const second = runReference();
    await step(second.harness.driver, second.finalTick + 2, 300);
    await second.harness.handle.whenStopped;
    expect(second.harness.last()).toEqual(first.harness.last());
  });
});

describe("engine lifecycle: the run ends at the deadline, not at the marker", () => {
  it("keeps the Clock live after the marker drains and wins at the final deadline", async () => {
    // Five Events drain in the first few ticks; the deadline is far later. The
    // marker draining must NOT end the run: the Clock ticks on to the deadline.
    const events = [0, 1, 2, 3, 4].map((t) => ev(t, t * GAME_SECONDS_PER_TICK));
    const h = launch({ generator: scheduleOf(events), checkpoints: deadlineAt(40) });
    await step(h.driver, 12); // well past the drain, well before the deadline
    const midway = h.last();
    expect(midway).toBeDefined();
    if (!midway) return;
    expect(midway.status).toBe("running"); // still live: the marker did not end it
    expect(midway.completed).toBe(5); // yet every Event already drained
    await step(h.driver, 30); // reach the deadline at tick 40
    await h.handle.whenStopped;
    const final = h.last();
    expect(final?.status).toBe("won");
    expect(final?.failureReason).toBeNull();
  });

  it("force-publishes exactly one terminal frame at the win", async () => {
    // Seven Events over ticks 0..6, then a distant deadline. A normal sample runs
    // while the run is live, then the terminal forced publish flips status to won
    // with the Queue drained.
    const events = [0, 1, 2, 3, 4, 5, 6].map((t) => ev(t, t * GAME_SECONDS_PER_TICK));
    const h = launch({ generator: scheduleOf(events), checkpoints: deadlineAt(9) });
    await step(h.driver, 10);
    await h.handle.whenStopped;
    const forced = h.snapshots.at(-1);
    const normal = h.snapshots.at(-2);
    expect(forced).toBeDefined();
    expect(normal).toBeDefined();
    if (!forced || !normal) return;
    expect(forced.status).toBe("won");
    expect(normal.status).toBe("running");
    expect(forced.queued).toBe(0);
  });

  it("absorbs a throwing terminal setSnapshot and still resolves", async () => {
    let calls = 0;
    const h = launch({
      generator: scheduleOf([ev(0, 0)]),
      checkpoints: deadlineAt(2),
      setSnapshot: () => {
        calls += 1;
        throw new Error("snapshot boom");
      },
    });
    await step(h.driver, 3);
    await h.handle.whenStopped; // resolves despite the throwing publish
    expect(calls).toBeGreaterThan(0); // the engine kept publishing through the throw
  });
});

describe("engine failure and stop paths", () => {
  it("force-publishes a failed terminal frame on a task failure and reports it", async () => {
    const errors: unknown[] = [];
    const throwing: TaskAlgorithm = {
      normalize: (raw) => raw,
      detect: () => {
        throw new Error("boom in detect");
      },
    };
    const h = launch({
      generator: scheduleOf([ev(0, 0)]),
      algorithm: throwing,
      checkpoints: deadlineAt(50),
      onError: (error) => errors.push(error),
    });
    await step(h.driver, 3);
    await h.handle.whenStopped;
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(RuleError);
    const snap = h.last();
    expect(snap?.status).toBe("failed"); // the HUD sees the failure
    expect(snap?.failureReason).toBeNull(); // a task failure has no typed reason
  });

  it("absorbs both a throwing terminal setSnapshot and a throwing onError", async () => {
    let reported: unknown;
    const h = launch({
      generator: scheduleOf([ev(0, 0)]),
      checkpoints: deadlineAt(50),
      algorithm: {
        normalize: (raw) => raw,
        detect: () => {
          throw new Error("boom in detect");
        },
      },
      setSnapshot: () => {
        throw new Error("snapshot boom");
      },
      onError: (error) => {
        reported = error;
        throw new Error("reporter also boom");
      },
    });
    await step(h.driver, 3);
    await h.handle.whenStopped; // still resolves
    expect(reported).toBeInstanceOf(RuleError); // onError saw the task failure first
  });

  it("publishes nothing on an explicit stop", async () => {
    let nextId = 0;
    // A source that never exhausts: each Event is due far in the future, so Ingest
    // sleeps and the run never completes on its own.
    const h = launch({ generator: () => ev(nextId++, 10_000) });
    await step(h.driver, 7); // a couple of normal samples run
    const afterStop = h.snapshots.length;
    expect(afterStop).toBeGreaterThan(0);
    h.handle.stop();
    await h.handle.whenStopped;
    expect(h.snapshots.length).toBe(afterStop); // stop is a teardown, not an outcome
  });

  it("writes no snapshot after stop", async () => {
    let nextId = 0;
    const h = launch({ generator: () => ev(nextId++, 10_000) });
    await step(h.driver, 30);
    const count = h.snapshots.length;
    expect(count).toBeGreaterThan(0);
    h.handle.stop();
    await step(h.driver, 30);
    expect(h.snapshots.length).toBe(count);
  });

  it("finishes teardown even when the driver's stop throws", async () => {
    class BadStopDriver extends ManualDriver {
      override stop(): void {
        throw new Error("driver stop boom");
      }
    }
    let nextId = 0;
    const driver = new BadStopDriver();
    const handle = start({
      getGraph,
      setSnapshot: () => undefined,
      algorithm: idleAlgorithm,
      scorer: createScorer([], SCORER_CONFIG),
      generator: () => ev(nextId++, 10_000),
      serviceRate: FAST_RATE,
      checkpoints: [],
      waves: [],
      driver,
    });
    await step(driver, 20);
    handle.stop(); // the engine swallows the driver throw
    await handle.whenStopped; // still settles
    expect(true).toBe(true);
  });

  it("surfaces a throwing sampler once, then stops", async () => {
    const errors: unknown[] = [];
    let calls = 0;
    let nextId = 0;
    const h = launch({
      generator: () => ev(nextId++, 10_000),
      setSnapshot: () => {
        calls++;
        throw new Error("boom in sampler");
      },
      onError: (error) => errors.push(error),
    });
    await step(h.driver, 20);
    expect(errors).toHaveLength(1);
    expect(calls).toBe(1); // a sampler failure does not force-publish through the broken sink
    await h.handle.whenStopped;
  });
});

describe("engine backpressure ceiling (M2 seam 5)", () => {
  it("saturates the Queue near 2 * CHANNEL_CAP with the Detect->Sink channel near empty", async () => {
    // A flood of Events due now, against a slow service rate. The two upstream
    // channels fill to cap; the Detect->Sink channel stays near empty because the
    // Sink drains at once, so the total Queue tops out near 2 * CHANNEL_CAP.
    let nextId = 0;
    const h = launch({
      generator: () => ev(nextId++, 0), // never exhausts, all due at tick 0
      serviceRate: { num: 1, den: 1 }, // one record per tick: far below arrival
    });
    await step(h.driver, 40); // reach steady state
    const snap = h.last();
    expect(snap).toBeDefined();
    if (!snap) return;
    const ceiling = 2 * CHANNEL_CAP;
    expect(snap.queued).toBeGreaterThanOrEqual(ceiling - 2);
    expect(snap.queued).toBeLessThanOrEqual(ceiling + 2); // not near 3*CAP: e3 stays empty
    expect(snap.admitted - snap.completed).toBeGreaterThanOrEqual(ceiling - 2);
    h.handle.stop();
    await h.handle.whenStopped;
  });
});

describe("engine checkpoint clear, exact tick phase (M2 seam 6)", () => {
  // One Event admitted early and serviced at one record per tick: its governor
  // sleep is due on tick 2, so it is still in service at the start-of-tick-2
  // checkpoint boundary and completes only as tick 2's continuations run.
  const SLOW: ServiceRate = { num: 1, den: 1 };

  it("counts an Event still in service on the exact checkpoint tick as outstanding", async () => {
    const h = launch({
      generator: scheduleOf([ev(0, 0)]),
      serviceRate: SLOW,
      checkpoints: deadlineAt(2),
    });
    await step(h.driver, 3);
    await h.handle.whenStopped;
    expect(h.last()?.status).toBe("failed");
    expect(h.last()?.failureReason).toBe("queue");
  });

  it("clears once the Event has completed by the next checkpoint tick", async () => {
    const h = launch({
      generator: scheduleOf([ev(0, 0)]),
      serviceRate: SLOW,
      checkpoints: deadlineAt(3),
    });
    await step(h.driver, 4);
    await h.handle.whenStopped;
    expect(h.last()?.status).toBe("won");
    expect(h.last()?.failureReason).toBeNull();
  });
});

describe("engine final deadline over a live Clock (M2 seam 7)", () => {
  it("wins with a fast rule that drained long before the deadline", async () => {
    const events = [0, 1, 2, 3, 4].map((t) => ev(t, t * GAME_SECONDS_PER_TICK));
    const h = launch({
      generator: scheduleOf(events),
      serviceRate: FAST_RATE,
      checkpoints: deadlineAt(40),
    });
    await step(h.driver, 41);
    await h.handle.whenStopped;
    expect(h.last()?.status).toBe("won");
  });

  it("fails at the deadline with a slow rule still holding Queue", async () => {
    const events = [0, 1, 2, 3, 4].map((t) => ev(t, t * GAME_SECONDS_PER_TICK));
    const h = launch({
      generator: scheduleOf(events),
      serviceRate: { num: 1, den: 20 }, // 0.05 records per tick: cannot keep up
      checkpoints: deadlineAt(40),
    });
    await step(h.driver, 41);
    await h.handle.whenStopped;
    expect(h.last()?.status).toBe("failed");
    expect(h.last()?.failureReason).toBe("queue");
  });
});

describe("engine terminal snapshot reaches the HUD (M2 seam 8)", () => {
  it("leaves the last published snapshot terminal, not a stale running frame", async () => {
    const events = [0, 1, 2, 3, 4].map((t) => ev(t, t * GAME_SECONDS_PER_TICK));
    const h = launch({
      generator: scheduleOf(events),
      serviceRate: { num: 1, den: 20 },
      checkpoints: deadlineAt(40),
    });
    await step(h.driver, 41);
    await h.handle.whenStopped;
    const last = h.last();
    expect(last).toBeDefined();
    if (!last) return;
    expect(last.status).not.toBe("running");
    expect(last.status).toBe("failed");
    expect(last.failureReason).toBe("queue");
  });
});

describe("engine Correctness settles at a checkpoint (M2 seam 11)", () => {
  it("fails on Correctness via advanceTo, with no Event in the gap and no end of stream", async () => {
    // One Attack whose window closes at ts 10 (tick 5). The rule never alerts, so
    // the Attack stays pending; every Event finishes before the checkpoint, so the
    // Queue is clear. The checkpoint at tick 10 sits in a drain gap with no later
    // Event: only scorer.advanceTo can settle the miss, dropping Correctness.
    const attack: Attack = {
      id: 1,
      entity: "root",
      reason: "pin_brute_force",
      window: { startTs: 0, endTs: 10 },
      eventIds: [0, 1, 2, 3, 4],
      threshold: PIN_BRUTE_FORCE_THRESHOLD,
    };
    // Events at ts 0..8 (ticks 0..4), all before the window close and the gap.
    const events = [0, 1, 2, 3, 4].map((k) => ev(k, k * GAME_SECONDS_PER_TICK));
    const h = launch({
      generator: scheduleOf(events),
      scorer: createScorer([attack], SCORER_CONFIG),
      serviceRate: FAST_RATE, // Queue clears well before the checkpoint
      checkpoints: deadlineAt(10),
    });
    await step(h.driver, 11);
    await h.handle.whenStopped;
    expect(h.last()?.status).toBe("failed");
    expect(h.last()?.failureReason).toBe("correctness");
    expect(h.last()?.correctness.missed).toBe(1); // settled by advanceTo, not EOS
  });
});

describe("engine speed changes only wall pacing (M4 seam 5)", () => {
  // A ManualDriver that also records every wall-clock rate setSpeed arms it at. The
  // recorded rate proves setSpeed actually reached the driver; the by-hand ticks ignore
  // that rate, so the tick sequence stays identical across speeds. Without the recording
  // this test would be vacuous: it would pass even if setSpeed never called setRate.
  class RateSpyManualDriver extends ManualDriver {
    readonly rates: number[] = [];
    override setRate(hz: number): void {
      this.rates.push(hz);
    }
  }

  // Drive one fixed seed to the deadline at a given speed and collect every snapshot and
  // every armed rate.
  async function runAtSpeed(speed: number): Promise<{ snapshots: SimSnapshot[]; rates: number[] }> {
    const driver = new RateSpyManualDriver();
    const events = [0, 1, 2, 3, 4].map((t) => ev(t, t * GAME_SECONDS_PER_TICK));
    const snapshots: SimSnapshot[] = [];
    const handle = start({
      getGraph,
      setSnapshot: (snapshot) => snapshots.push(snapshot),
      algorithm: idleAlgorithm,
      scorer: createScorer([], SCORER_CONFIG),
      generator: scheduleOf(events),
      serviceRate: FAST_RATE,
      checkpoints: deadlineAt(20),
      waves: [],
      driver,
    });
    handle.setSpeed(speed);
    await step(driver, 22);
    await handle.whenStopped;
    return { snapshots, rates: driver.rates };
  }

  it("arms the driver at a distinct rate per speed yet replays an identical snapshot sequence", async () => {
    const half = await runAtSpeed(0.5);
    const one = await runAtSpeed(1);
    const two = await runAtSpeed(2);
    // setSpeed reached the driver with baseHz * multiplier, a distinct rate per speed.
    expect(half.rates).toEqual([CLOCK_HZ * 0.5]);
    expect(one.rates).toEqual([CLOCK_HZ]);
    expect(two.rates).toEqual([CLOCK_HZ * 2]);
    // The by-hand tick sequence ignores the wall rate, so the snapshots match exactly.
    expect(one.snapshots).toEqual(half.snapshots);
    expect(two.snapshots).toEqual(half.snapshots);
  });
});

// Seam: the snapshot's findings, events, and processed watermark (GH28-PLAN.md T3).
describe("engine publishes findings, events, and the processed watermark", () => {
  it("carries a live finding and its ring event while Detect still holds the Event in service", async () => {
    // One Event, and a governor slow enough that Detect is still sleeping off its
    // charge when we sample: the end-of-stream marker cannot have reached Detect
    // yet (finalize() would otherwise have cleared the live set), so this is the
    // one window where a short run's live finding is guaranteed to be observable.
    const events = [ev(0, 0, { acct: "x" })];
    const alertingAlgorithm: TaskAlgorithm = {
      normalize: (raw) => raw,
      detect: () => [{ alert: { reason: "pin_brute_force", at: 0, eventIds: [0] }, eventId: 0 }],
    };
    const h = launch({
      generator: scheduleOf(events),
      algorithm: alertingAlgorithm,
      serviceRate: { num: 1, den: 10 }, // 0.1 records/tick: a ~10-tick charge
      checkpoints: deadlineAt(50),
    });
    await step(h.driver, 3); // well inside the charge, before Detect reaches the marker
    const midway = h.last();
    expect(midway).toBeDefined();
    if (!midway) return;
    expect(midway.status).toBe("running"); // still mid-charge, not yet at the deadline
    expect(midway.findings.length).toBeGreaterThan(0); // the scorer's live set folded in
    expect(midway.events.length).toBeGreaterThan(0); // the ring folded in
    expect(midway.events[0]).toMatchObject({ id: 0, endpoint: "kiosk-v1" });
    expect(midway.processed).toBe(1); // Detect already recorded and marked this Event
    h.handle.stop();
    await h.handle.whenStopped;
  });

  it("keeps admitted - processed at 0 after a full drain (guards the off-by-one)", async () => {
    const events = [0, 1, 2, 3, 4].map((t) => ev(t, t * GAME_SECONDS_PER_TICK));
    const h = launch({ generator: scheduleOf(events), checkpoints: deadlineAt(40) });
    await step(h.driver, 41);
    await h.handle.whenStopped;
    const snap = h.last();
    expect(snap).toBeDefined();
    if (!snap) return;
    expect(snap.admitted - snap.processed).toBe(0);
  });

  it("emptySnapshot has empty findings, decisions, and events arrays and a zero watermark", () => {
    const snap = emptySnapshot();
    expect(snap.findings).toEqual([]);
    expect(snap.decisions).toEqual([]);
    expect(snap.events).toEqual([]);
    expect(snap.processed).toBe(0);
  });

  it("emptySnapshot carries empty map fields and nowTick 0 (GH117 Part E)", () => {
    const snap = emptySnapshot();
    expect(snap.actors).toEqual([]);
    expect(snap.flashes).toEqual([]);
    expect(snap.doors).toEqual([]);
    expect(snap.crowds).toEqual([]);
    expect(snap.nowTick).toBe(0);
  });
});

describe("engine publishes the wave reading (GH38+40-PLAN.md Part 1)", () => {
  // The wave's ticks are chosen as multiples of the sampler's publish cadence
  // (CLOCK_HZ / PUBLISH_HZ = 3 ticks/sample), so a regular, non-forced publish
  // lands exactly on each phase boundary this test checks.
  const START_TICK = 60;
  const DURATION_TICKS = 6;
  const WAVES: Wave[] = [
    { startTick: START_TICK, durationTicks: DURATION_TICKS, eventsPerTick: 4 },
  ];

  it("carries snapshot.wave through calm, incoming, active, and after the last wave", async () => {
    const h = launch({
      generator: scheduleOf([]),
      checkpoints: deadlineAt(START_TICK + DURATION_TICKS + 24),
      waves: WAVES,
    });

    await step(h.driver, 3); // well before the warn window
    expect(h.last()?.wave).toEqual({
      phase: "calm",
      index: 0,
      ticksUntilNext: START_TICK - 3,
      eventsPerTick: null,
    });

    await step(h.driver, START_TICK - WAVE_WARN_TICKS - 3); // now at startTick - WAVE_WARN_TICKS
    expect(h.last()?.wave).toEqual({
      phase: "incoming",
      index: 0,
      ticksUntilNext: WAVE_WARN_TICKS,
      eventsPerTick: null,
    });

    await step(h.driver, WAVE_WARN_TICKS); // now at startTick: the wave's first tick
    expect(h.last()?.wave).toEqual({
      phase: "active",
      index: 0,
      ticksUntilNext: null,
      eventsPerTick: 4,
    });

    await step(h.driver, DURATION_TICKS); // now at startTick + durationTicks: past the wave
    expect(h.last()?.wave).toEqual({
      phase: "calm",
      index: null,
      ticksUntilNext: null,
      eventsPerTick: null,
    });

    h.handle.stop();
    await h.handle.whenStopped;
  });

  it("keeps a sane wave reading in the terminal frame", async () => {
    const events = [0, 1, 2, 3, 4].map((t) => ev(t, t * GAME_SECONDS_PER_TICK));
    const h = launch({
      generator: scheduleOf(events),
      serviceRate: { num: 1, den: 20 }, // slow enough to still be queued at the deadline
      checkpoints: deadlineAt(40),
      waves: WAVES,
    });
    await step(h.driver, 41);
    await h.handle.whenStopped;
    // The run fails on Queue at tick 40, inside the wave's warn window (it starts
    // at 60): incoming, with the still-ahead wave's index, not a stale reading.
    expect(h.last()?.status).toBe("failed");
    expect(h.last()?.wave).toEqual({
      phase: "incoming",
      index: 0,
      ticksUntilNext: START_TICK - 40,
      eventsPerTick: null,
    });
  });
});

// Seam: the snapshot's decisions, bound to the inspector ring (GH34-35-PLAN.md 2.2).
describe("engine publishes decisions bound to the inspector ring (T10)", () => {
  /** One Event, one Attack it fully proves, so record() resolves it caught at once. */
  function caughtSetup(): { events: PipeEvent[]; scorer: Scorer } {
    const events = [ev(0, 0, { acct: "x" })];
    const attack: Attack = {
      id: 1,
      entity: "root",
      reason: "pin_brute_force",
      window: { startTs: 0, endTs: 100 },
      eventIds: [0],
      threshold: 1,
    };
    return { events, scorer: createScorer([attack], { window: 10, wFn: 3, wFp: 1 }) };
  }

  const alertingAlgorithm: TaskAlgorithm = {
    normalize: (raw) => raw,
    detect: () => [{ alert: { reason: "pin_brute_force", at: 0, eventIds: [0] }, eventId: 0 }],
  };

  it("carries a caught decision with citedEvents resolved against the inspector ring", async () => {
    const { events, scorer } = caughtSetup();
    const h = launch({
      generator: scheduleOf(events),
      algorithm: alertingAlgorithm,
      scorer,
      checkpoints: deadlineAt(50),
    });
    await step(h.driver, 51);
    await h.handle.whenStopped;
    const snap = h.last();
    expect(snap).toBeDefined();
    if (!snap) return;
    expect(snap.decisions).toHaveLength(1);
    const decision = snap.decisions[0];
    expect(decision?.outcome).toBe("caught");
    if (decision?.outcome !== "caught") return;
    expect(decision.citedEvents).toHaveLength(1);
    expect(decision.citedEvents[0]).toMatchObject({ id: 0, endpoint: "kiosk-v1" });
  });

  it("publishes a frozen decisions array of frozen decisions", async () => {
    const { events, scorer } = caughtSetup();
    const h = launch({
      generator: scheduleOf(events),
      algorithm: alertingAlgorithm,
      scorer,
      checkpoints: deadlineAt(50),
    });
    await step(h.driver, 51);
    await h.handle.whenStopped;
    const snap = h.last();
    expect(snap).toBeDefined();
    if (!snap) return;
    expect(Object.isFrozen(snap.decisions)).toBe(true);
    expect(snap.decisions[0] !== undefined && Object.isFrozen(snap.decisions[0])).toBe(true);
  });

  it("emptySnapshot has an empty, frozen decisions array", () => {
    const snap = emptySnapshot();
    expect(snap.decisions).toEqual([]);
    expect(Object.isFrozen(snap.decisions)).toBe(true);
  });
});

// Freeze-on-raise: a live finding's own citedEvents, resolved against the inspector ring
// at capture time and carried on the row itself (LiveFinding.citedEvents), so its trace
// need not resolve against the churning ring later.
describe("engine publishes a live finding's citedEvents, resolved against the inspector ring", () => {
  it("carries citedEvents on a live finding, observed mid-run, before finalize clears it", async () => {
    const alertingAlgorithm: TaskAlgorithm = {
      normalize: (raw) => raw,
      detect: () => [{ alert: { reason: "pin_brute_force", at: 0, eventIds: [0] }, eventId: 0 }],
    };
    // A far-future second Event keeps Ingest's source open (it never returns null), so
    // the run never reaches end-of-stream and finalize() — which clears the whole live
    // set — never fires during this test. That is the only way to observe a live
    // finding's citedEvents at all: by the time a real run terminates, the row is gone.
    let sent = 0;
    const openSource = (): PipeEvent => {
      sent += 1;
      return sent === 1 ? ev(0, 0, { acct: "x" }) : ev(999, 1_000_000, { acct: "x" });
    };
    const h = launch({
      generator: openSource,
      algorithm: alertingAlgorithm,
      checkpoints: deadlineAt(1_000_000),
    });
    await step(h.driver, 5);
    const midway = h.last();
    expect(midway).toBeDefined();
    if (!midway) return;
    expect(midway.status).toBe("running"); // still open: finalize has not run
    expect(midway.findings).toHaveLength(1);
    expect(midway.findings[0]?.citedEvents).toHaveLength(1);
    expect(midway.findings[0]?.citedEvents[0]).toMatchObject({ id: 0, endpoint: "kiosk-v1" });
    h.handle.stop();
    await h.handle.whenStopped;
  });
});

// GH37-PLAN.md: the scorer's decision log rides along in the same snapshot.
describe("engine publishes the scorer's decision log", () => {
  it("carries every decision the reference run resolves, in the final snapshot", async () => {
    const run = pinBruteForce.generate(LEVEL_SEED);
    const finalTick = run.checkpoints[run.checkpoints.length - 1]?.atTick ?? 0;
    const harness = launch({
      generator: scheduleOf(run.events),
      algorithm: referenceTaskAlgorithm(),
      scorer: createScorer(run.attacks, SCORER_CONFIG),
      checkpoints: run.checkpoints,
    });
    await step(harness.driver, finalTick + 2, 300);
    await harness.handle.whenStopped;
    const snap = harness.last();
    expect(snap).toBeDefined();
    if (!snap) return;
    expect(snap.decisions).toHaveLength(run.attacks.length);
    expect(snap.decisions.every((d) => d.outcome === "caught")).toBe(true);
  });

  it("reuses the array reference across publishes while decisionCount is unchanged, and refreshes it once it grows", async () => {
    let log: Decision[] = [];
    const missed: MissedDecision = {
      outcome: "missed",
      seq: 0,
      at: 10,
      resolvedAt: 10,
      attackId: 1,
      entity: "root",
      reason: "pin_brute_force",
      window: { startTs: 0, endTs: 10 },
    };
    const fakeScorer: Scorer = {
      record: () => undefined,
      advanceTo: () => undefined,
      finalize: () => undefined,
      reading: () => ({ rolling: 100, caught: 0, missed: 0, falseAlerts: 0 }),
      bindEventResolver: () => undefined,
      decisionCount: () => log.length,
      decisions: () => Object.freeze([...log]),
      liveFindings: () => Object.freeze([]),
    };
    const h = launch({ generator: () => null, scorer: fakeScorer, checkpoints: [] });
    await step(h.driver, CLOCK_HZ); // several publish ticks, decisionCount stays 0
    const first = h.last();
    await step(h.driver, CLOCK_HZ);
    const second = h.last();
    expect(second?.decisions).toBe(first?.decisions); // no growth: the sampler reused it
    log = [missed]; // decisionCount grows from 0 to 1
    await step(h.driver, CLOCK_HZ);
    const third = h.last();
    expect(third?.decisions).not.toBe(first?.decisions); // grew: a fresh array was read
    expect(third?.decisions).toEqual([missed]);
    h.handle.stop();
    await h.handle.whenStopped;
  });
});

// GH37-PLAN.md: a decision `finalize()` appends at end-of-stream (not a checkpoint's
// advanceTo) must still reach the terminal snapshot.
describe("engine carries a finalize decision through to the terminal snapshot", () => {
  it("publishes a decision finalize resolves for an Attack whose window outlives the deadline", async () => {
    // The window ends far past the deadline, so only finalize (end-of-stream, which
    // closes EVERY pending Attack regardless of window) can resolve it; a checkpoint's
    // advanceTo cannot, since the window has not yet "ended" by the deadline's ts.
    const attack: Attack = {
      id: 1,
      entity: "root",
      reason: "pin_brute_force",
      window: { startTs: 0, endTs: 100_000 },
      eventIds: [0, 1],
      threshold: 2,
    };
    const events = [ev(0, 0), ev(1, GAME_SECONDS_PER_TICK)];
    const h = launch({
      generator: scheduleOf(events),
      scorer: createScorer([attack], SCORER_CONFIG),
      checkpoints: deadlineAt(40),
    });
    await step(h.driver, 41);
    await h.handle.whenStopped;
    const last = h.last();
    expect(last).toBeDefined();
    if (!last) return;
    const missed = last.decisions.find((d) => d.outcome === "missed");
    expect(missed).toMatchObject({ attackId: 1, entity: "root" });
  });
});

// GH117-PLAN.md "Part B": the engine ALSO steps the scenario cast on its one Clock and
// publishes the cast's presence and wrong-PIN / sign-in flashes into the map fields.
// Scoring is untouched — it always runs off `generator`, never the cast.
const CAST_ENV: WorldEnv = {
  world,
  distances: distanceTable(world),
  timetable: buildTimetable(world),
};

/** A PIN attacker cast member: kind "pin-attacker", one wrong-PIN fail per timestamp. */
function attackerMember(id: string, station: string, failTimestamps: number[]): ScenarioCastMember {
  const config = { id, account: "victim", station, terminal: "K1", failTimestamps };
  return {
    actor: createPinAttacker(config),
    kind: "pin-attacker",
    provenance: "scored-scenario",
    initialPresence: (firstTick) => initialPinAttackerPresence(station, firstTick),
  };
}

/** A benign patron cast member: kind "account-rider", `fumbleFails` fails then a sign-in. */
function patronMember(
  id: string,
  station: string,
  startTick: number,
  fumbleFails: 0 | 1 | 2,
): ScenarioCastMember {
  const config = {
    id,
    account: "rider",
    station,
    terminal: "K1",
    startTick,
    dwellTicks: 4,
    fumbleFails,
  };
  return {
    actor: createAccountRider(config),
    kind: "account-rider",
    provenance: "scored-scenario",
    initialPresence: (firstTick) => initialAccountRiderPresence(station, firstTick),
  };
}

/** A test stub that acts every tick, recording the tick, to prove the step cadence. */
function metronome(id: string, station: string, acted: number[]): Actor<WorldReading, WorldEnv> {
  return {
    id,
    start: () => 0,
    act: ({ tick }) => {
      acted.push(tick);
      const reading: WorldReading = {
        sensor: "kiosk",
        reading: {
          ts: tick * GAME_SECONDS_PER_TICK,
          account: "m",
          station,
          terminal: "K1",
          outcome: "success",
        },
      };
      return {
        readings: [reading],
        nextTick: tick + 1,
        presence: { kind: "at", node: station, fromTick: tick, untilTick: tick + 1 },
      };
    },
  };
}

function castOf(members: ScenarioCastMember[], runSeed = 1): ScenarioCast {
  return { members, env: CAST_ENV, runSeed };
}

describe("engine steps the scenario cast for the map (GH117 Part B)", () => {
  it("publishes ActorView presence, tagging an attacker pin-attacker and a patron its own kind", async () => {
    const cast = castOf([
      attackerMember("attack-0", "cen", [40]), // arrives at tick 0, fails at tick 20
      patronMember("patron-0", "cen", 3, 0), // signs in at tick 3
    ]);
    const h = launch({ scenarioCast: cast, checkpoints: deadlineAt(100) });
    await step(h.driver, 4);
    const snap = h.last();
    expect(snap).toBeDefined();
    if (!snap) return;
    const byId = new Map(snap.actors.map((a) => [a.id, a]));
    expect(byId.get("attack-0")?.kind).toBe("pin-attacker");
    expect(byId.get("patron-0")?.kind).toBe("account-rider");
    // The attacker has arrived and stands at its victim's station.
    expect(byId.get("attack-0")?.presence).toMatchObject({ kind: "at", node: "cen" });
    h.handle.stop();
  });

  it("advances exactly one integer tick per game tick, seeded by the priming advanceTo(1)", async () => {
    const acted: number[] = [];
    const cast: ScenarioCast = {
      members: [
        {
          actor: metronome("m", "cen", acted),
          kind: "account-rider",
          provenance: "scored-scenario",
          initialPresence: (t) => initialAccountRiderPresence("cen", t),
        },
      ],
      env: CAST_ENV,
      runSeed: 1,
    };
    const h = launch({ scenarioCast: cast, checkpoints: deadlineAt(100) });
    await step(h.driver, 12);
    h.handle.stop();
    // Priming acts tick 0; each of the 12 clock ticks acts the next tick, in order.
    expect(acted).toEqual(Array.from({ length: 13 }, (_, i) => i));
  });

  it("does not change the stepping tick order when Clock.setSpeed is called", async () => {
    const acted: number[] = [];
    const cast: ScenarioCast = {
      members: [
        {
          actor: metronome("m", "cen", acted),
          kind: "account-rider",
          provenance: "scored-scenario",
          initialPresence: (t) => initialAccountRiderPresence("cen", t),
        },
      ],
      env: CAST_ENV,
      runSeed: 1,
    };
    const h = launch({ scenarioCast: cast, checkpoints: deadlineAt(100) });
    await step(h.driver, 5);
    h.handle.setSpeed(2); // wall-clock pacing only; the tick sequence must not move
    await step(h.driver, 5);
    h.handle.setSpeed(0.5);
    await step(h.driver, 5);
    h.handle.stop();
    // A contiguous 0..15 despite the speed changes: one integer tick per game tick.
    expect(acted).toEqual(Array.from({ length: 16 }, (_, i) => i));
  });

  it("raises a pinfail flash for a wrong-PIN fail and a signin flash for a sign-in, on the kiosk chip", async () => {
    const cast = castOf([
      attackerMember("attack-0", "cen", [40]), // wrong-PIN fail at tick 20
      patronMember("patron-0", "cen", 3, 1), // one fumble fail then a success, at tick 3
    ]);
    const h = launch({ scenarioCast: cast, checkpoints: deadlineAt(100) });
    await step(h.driver, 21);
    const snap = h.last();
    expect(snap).toBeDefined();
    if (!snap) return;
    const kiosk = kioskNodeId("cen");
    const pinfails = snap.flashes.filter((f) => f.kind === "pinfail");
    const signins = snap.flashes.filter((f) => f.kind === "signin");
    // Two wrong-PIN fails (the patron's fumble at tick 3, the attacker's at tick 20) and
    // one sign-in (the patron's success at tick 3), all on the station's kiosk chip.
    expect(pinfails.map((f) => f.atTick).sort((a, b) => a - b)).toEqual([3, 20]);
    expect(signins).toHaveLength(1);
    expect(signins[0]?.atTick).toBe(3);
    for (const flash of [...pinfails, ...signins]) {
      expect(flash.node).toBe(kiosk);
    }
    h.handle.stop();
  });

  it("carries the real blueprint's cast, mapping attackers to pin-attacker and patrons to account-rider", async () => {
    const blueprint = buildBlueprint(LEVEL_SEED);
    const actors = blueprint.instantiate();
    const members: ScenarioCastMember[] = actors.map((actor, i) => {
      const d = blueprint.descriptors[i];
      if (!d) throw new Error("descriptor/actor misalignment");
      return { actor, kind: d.kind, provenance: d.provenance, initialPresence: d.initialPresence };
    });
    const h = launch({
      scenarioCast: { members, env: blueprint.env, runSeed: LEVEL_SEED },
      checkpoints: deadlineAt(100),
    });
    await step(h.driver, 3);
    const snap = h.last();
    expect(snap).toBeDefined();
    if (!snap) return;
    const kinds = new Set(snap.actors.map((a) => a.kind));
    expect(kinds.has("pin-attacker")).toBe(true);
    expect(kinds.has("account-rider")).toBe(true);
    h.handle.stop();
  });

  it("keeps scoring byte-identical whether or not a scenario cast is attached", async () => {
    const run = pinBruteForce.generate(LEVEL_SEED);
    const finalTick = run.checkpoints[run.checkpoints.length - 1]?.atTick ?? 0;
    const scoringFields = (snap: SimSnapshot) => ({
      status: snap.status,
      failureReason: snap.failureReason,
      admitted: snap.admitted,
      completed: snap.completed,
      correctness: snap.correctness,
      decisions: snap.decisions,
      findings: snap.findings,
      queued: snap.queued,
    });

    const bare = launch({
      generator: scheduleOf(run.events),
      algorithm: referenceTaskAlgorithm(),
      scorer: createScorer(run.attacks, SCORER_CONFIG),
      checkpoints: run.checkpoints,
    });
    await step(bare.driver, finalTick + 2, 300);
    await bare.handle.whenStopped;

    const blueprint = buildBlueprint(LEVEL_SEED);
    const actors = blueprint.instantiate();
    const members: ScenarioCastMember[] = actors.map((actor, i) => {
      const d = blueprint.descriptors[i];
      if (!d) throw new Error("descriptor/actor misalignment");
      return { actor, kind: d.kind, provenance: d.provenance, initialPresence: d.initialPresence };
    });
    const withCast = launch({
      generator: scheduleOf(run.events),
      algorithm: referenceTaskAlgorithm(),
      scorer: createScorer(run.attacks, SCORER_CONFIG),
      checkpoints: run.checkpoints,
      scenarioCast: { members, env: blueprint.env, runSeed: LEVEL_SEED },
    });
    await step(withCast.driver, finalTick + 2, 300);
    await withCast.handle.whenStopped;

    const bareLast = bare.last();
    const castLast = withCast.last();
    expect(bareLast).toBeDefined();
    expect(castLast).toBeDefined();
    if (!bareLast || !castLast) return;
    // Scoring is identical; only the map fields (actors/flashes/nowTick) differ.
    expect(scoringFields(castLast)).toEqual(scoringFields(bareLast));
    // The cast really ran (some publish carried live actors), while the bare run never
    // stepped one: its map fields stay empty and nowTick stays 0, exactly as before.
    expect(withCast.snapshots.some((snap) => snap.actors.length > 0)).toBe(true);
    expect(bareLast.actors).toHaveLength(0);
    expect(bareLast.nowTick).toBe(0);
  });
});

// GH117-PLAN.md "Part B" (ambient): the merged engine ALSO folds the metro's ambient life
// (trains, operators, hosts, and the seeded rider/staff/account spawners) onto the SAME
// Clock and schedule as the scenario cast, populating every map field. Scoring is still
// the pre-generated generator's, never the ambient cast (decision 8).
const AMBIENT_TIMETABLE = buildTimetable(world);
const AMBIENT_ENV: WorldEnv = {
  world,
  distances: distanceTable(world),
  timetable: AMBIENT_TIMETABLE,
  // The ambient operators and hosts read the control reference; the scenario cast ignores it.
  control: controlReference,
};

/** The full ambient cast (trains/operators/hosts + the three seeded spawners) for a seed. */
function fullAmbient(seed: number): AmbientCast {
  return {
    fixtures: buildAmbientFixtures(world, AMBIENT_TIMETABLE),
    ...buildAmbientSpawners(world, seed),
  };
}

/**
 * A scenario cast member whose `act` records each tick's seeded rng draw. Two runs with an
 * identical assigned seed record an identical draw sequence; an ambient collision that
 * perturbed the scenario seed would change it. This is the load-bearing seed-isolation probe.
 */
function seedRecorder(
  id: string,
  station: string,
  draws: { tick: number; value: number }[],
): ScenarioCastMember {
  const actor: Actor<WorldReading, WorldEnv> = {
    id,
    start: () => 0,
    act: ({ tick, rng }) => {
      draws.push({ tick, value: rng() });
      const reading: WorldReading = {
        sensor: "kiosk",
        reading: {
          ts: tick * GAME_SECONDS_PER_TICK,
          account: "sr",
          station,
          terminal: "K1",
          outcome: "success",
        },
      };
      return {
        readings: [reading],
        nextTick: tick + 1,
        presence: { kind: "at", node: station, fromTick: tick, untilTick: tick + 1 },
      };
    },
  };
  return {
    actor,
    kind: "account-rider",
    provenance: "scored-scenario",
    initialPresence: (t) => initialAccountRiderPresence(station, t),
  };
}

/** An ambient account-rider spawner that admits exactly one rider at `atTick`, then stops. */
function oneAmbientAccountRider(id: string, station: string, atTick: number): AccountRiderSpawner {
  let done = false;
  return {
    tick: (nowTick) => {
      if (done || nowTick < atTick) {
        return [];
      }
      done = true;
      return [
        {
          actor: createAccountRider({
            id,
            account: "ambient",
            station,
            terminal: "K1",
            startTick: nowTick,
            dwellTicks: 4,
          }),
          kind: "account-rider",
          initialPresence: (t) => initialAccountRiderPresence(station, t),
        },
      ];
    },
  };
}

describe("engine folds the ambient metro cast onto the merged snapshot (GH117 Part B ambient)", () => {
  it("publishes ambient trains, riders, and staff with the right kinds and fills doors and crowds", async () => {
    const cast: ScenarioCast = {
      members: [attackerMember("attack-0", "cen", [400])],
      env: AMBIENT_ENV,
      runSeed: LEVEL_SEED,
    };
    const h = launch({
      scenarioCast: cast,
      ambientCast: fullAmbient(LEVEL_SEED),
      checkpoints: deadlineAt(600),
    });
    await step(h.driver, 240, 10);
    h.handle.stop();

    const kinds = new Set(h.snapshots.flatMap((snap) => snap.actors.map((a) => a.kind)));
    // The scenario attacker rode the same schedule as the ambient trains, riders, and staff.
    expect(kinds.has("pin-attacker")).toBe(true);
    expect(kinds.has("train")).toBe(true);
    expect(kinds.has("rider")).toBe(true);
    expect(kinds.has("staff")).toBe(true);
    // The reducers ran over the ambient grants: doors opened, crowds counted.
    expect(h.snapshots.some((snap) => snap.doors.length > 0)).toBe(true);
    expect(h.snapshots.some((snap) => snap.crowds.length > 0)).toBe(true);
    // nowTick advanced with the run.
    expect(h.last()?.nowTick).toBeGreaterThan(0);
  });

  it("steps the scenario cast identically whether or not the ambient cast is present (seed isolation)", async () => {
    const bareDraws: { tick: number; value: number }[] = [];
    const bare = launch({
      scenarioCast: {
        members: [seedRecorder("sr-0", "cen", bareDraws)],
        env: AMBIENT_ENV,
        runSeed: LEVEL_SEED,
      },
      checkpoints: deadlineAt(200),
    });
    await step(bare.driver, 40, 10);
    bare.handle.stop();

    const ambientDraws: { tick: number; value: number }[] = [];
    const withAmbient = launch({
      scenarioCast: {
        members: [seedRecorder("sr-0", "cen", ambientDraws)],
        env: AMBIENT_ENV,
        runSeed: LEVEL_SEED,
      },
      ambientCast: fullAmbient(LEVEL_SEED),
      checkpoints: deadlineAt(200),
    });
    await step(withAmbient.driver, 40, 10);
    withAmbient.handle.stop();

    // The scenario actor's seeded rng stream is byte-identical: same ticks, same draws, so
    // the ambient cast never perturbed its assigned seed or same-tick priority.
    expect(ambientDraws.length).toBeGreaterThan(0);
    expect(ambientDraws).toEqual(bareDraws);
    // And the ambient run really did carry ambient actors, so the comparison is meaningful.
    expect(
      withAmbient.snapshots.some((snap) => snap.actors.some((a) => a.provenance === "ambient")),
    ).toBe(true);
  });

  it("tags the scenario actor scored-scenario and the ambient actor ambient", async () => {
    const cast: ScenarioCast = {
      members: [patronMember("patron-0", "cen", 3, 0)], // a scored sign-in at tick 3
      env: CAST_ENV,
      runSeed: LEVEL_SEED,
    };
    const ambient: AmbientCast = {
      fixtures: [],
      accountSpawner: oneAmbientAccountRider("A-amb", "cen", 6), // an ambient sign-in near tick 6
    };
    const h = launch({ scenarioCast: cast, ambientCast: ambient, checkpoints: deadlineAt(60) });
    await step(h.driver, 20, 10);
    h.handle.stop();

    // Union every published snapshot's actors so a not-yet-admitted actor cannot hide.
    const seen = new Map<string, string | undefined>();
    for (const snap of h.snapshots) {
      for (const actor of snap.actors) {
        seen.set(actor.id, actor.provenance);
      }
    }
    expect(seen.get("patron-0")).toBe("scored-scenario");
    expect(seen.get("A-amb")).toBe("ambient");
  });

  it("keeps scoring byte-identical with the ambient cast attached (CRITICAL parity)", async () => {
    const run = pinBruteForce.generate(LEVEL_SEED);
    const finalTick = run.checkpoints[run.checkpoints.length - 1]?.atTick ?? 0;
    const scoringFields = (snap: SimSnapshot) => ({
      status: snap.status,
      failureReason: snap.failureReason,
      admitted: snap.admitted,
      completed: snap.completed,
      correctness: snap.correctness,
      decisions: snap.decisions,
      findings: snap.findings,
      queued: snap.queued,
    });

    const bare = launch({
      generator: scheduleOf(run.events),
      algorithm: referenceTaskAlgorithm(),
      scorer: createScorer(run.attacks, SCORER_CONFIG),
      checkpoints: run.checkpoints,
    });
    await step(bare.driver, finalTick + 2, 300);
    await bare.handle.whenStopped;

    const blueprint = buildBlueprint(LEVEL_SEED);
    const actors = blueprint.instantiate();
    const members: ScenarioCastMember[] = actors.map((actor, i) => {
      const d = blueprint.descriptors[i];
      if (!d) throw new Error("descriptor/actor misalignment");
      return { actor, kind: d.kind, provenance: d.provenance, initialPresence: d.initialPresence };
    });
    const env: WorldEnv = { ...blueprint.env, control: controlReference };
    const withAmbient = launch({
      generator: scheduleOf(run.events),
      algorithm: referenceTaskAlgorithm(),
      scorer: createScorer(run.attacks, SCORER_CONFIG),
      checkpoints: run.checkpoints,
      scenarioCast: { members, env, runSeed: LEVEL_SEED },
      ambientCast: {
        fixtures: buildAmbientFixtures(world, env.timetable),
        ...buildAmbientSpawners(world, LEVEL_SEED),
      },
    });
    await step(withAmbient.driver, finalTick + 2, 300);
    await withAmbient.handle.whenStopped;

    const bareLast = bare.last();
    const castLast = withAmbient.last();
    expect(bareLast).toBeDefined();
    expect(castLast).toBeDefined();
    if (!bareLast || !castLast) return;
    // Scoring runs off the pre-generated generator, so it is identical with the whole living
    // metro attached; only the map fields differ.
    expect(scoringFields(castLast)).toEqual(scoringFields(bareLast));
    expect(
      withAmbient.snapshots.some((snap) => snap.actors.some((a) => a.provenance === "ambient")),
    ).toBe(true);
  });
});

// The next three describe blocks are ported from world-engine.test.ts and
// world-control.test.ts ahead of GH117-PLAN.md deleting those files (and world-engine.ts
// itself). Each proves a merged-engine behavior that no surviving test otherwise reaches:
// the M6 control cast's flash folding, a real rider's full one-trip-then-evicted lifecycle,
// and the map fields staying bounded over a long run. The camera reducer, the door
// reducer, and the staff walk/rider-boarding-dwell math keep their own direct unit tests
// (camera-reducer.test.ts, door-reducer.test.ts, staff-spawner.test.ts, world-rider.test.ts),
// so those are not re-proven here.

/** The M6 control cast's env: the ambient operator and host fixtures read `control`. */
const CONTROL_ENV: WorldEnv = { ...CAST_ENV, control: controlReference };

/** One operator at the OCC and one host at "dep", exactly as the legacy world run built them. */
function controlFixtures(): AmbientFixture[] {
  const occId = world.controlCenter.id;
  return [
    {
      actor: createOperator({
        id: "OP1",
        node: occId,
        console: controlReference.consoles[0] ?? { operator: "red.disp", host: "OCC-1" },
        startTick: 0,
        cadenceTicks: OPERATOR_COMMAND_TICKS,
      }),
      kind: "operator",
      initialPresence: (firstTick) => initialOperatorPresence(occId, firstTick),
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

describe("engine folds the M6 control cast onto the merged snapshot (ported from world-control.test.ts)", () => {
  it("raises a command flash on the OCC console chip", async () => {
    const occId = world.controlCenter.id;
    const h = launch({
      scenarioCast: { members: [], env: CONTROL_ENV, runSeed: 3 },
      ambientCast: { fixtures: controlFixtures() },
      checkpoints: deadlineAt(200),
    });
    await step(h.driver, 40, 10);
    h.handle.stop();

    const commandFlash = h.snapshots
      .flatMap((snap) => snap.flashes)
      .find((f) => f.kind === "command");
    expect(commandFlash?.node).toBe(consoleNodeId(occId));
  });

  it("raises a packet flash on the site relay chip", async () => {
    const h = launch({
      scenarioCast: { members: [], env: CONTROL_ENV, runSeed: 3 },
      ambientCast: { fixtures: controlFixtures() },
      checkpoints: deadlineAt(200),
    });
    await step(h.driver, 40, 10);
    h.handle.stop();

    const packetFlash = h.snapshots
      .flatMap((snap) => snap.flashes)
      .find((f) => f.kind === "packet");
    expect(packetFlash?.node).toBe(relayNodeId("dep"));
  });

  it("keeps the operator and host present the whole run (never evicted)", async () => {
    const h = launch({
      scenarioCast: { members: [], env: CONTROL_ENV, runSeed: 3 },
      ambientCast: { fixtures: controlFixtures() },
      checkpoints: deadlineAt(700),
    });
    await step(h.driver, 600, 10);
    h.handle.stop();

    const kinds = h.last()?.actors.map((a) => a.kind) ?? [];
    expect(kinds).toContain("operator");
    expect(kinds).toContain("host");
  });
});

/**
 * A controlled rider spawner (GH116): admits one real `createWorldRider` whenever no
 * rider is live, mirroring the real `rider-spawner`'s refill-toward-target behavior
 * (target 1 here) without its randomness, so the test stays deterministic. Each
 * admission mints a fresh, distinct id, so a later id proves a genuine replacement, not
 * the same rider re-admitted.
 */
function controlledRiderSpawner(origin: string): RiderSpawner {
  let births = 0;
  return {
    tick: (nowTick, liveRiders) => {
      if (liveRiders > 0) {
        return [];
      }
      const id = `E${births}`;
      births += 1;
      // A high balance so the trip is always affordable and no TVM top-up detour
      // complicates the lifecycle this test is proving.
      const tripConfig: RiderTripConfig = {
        card: id,
        origin,
        balance: 1_000_000,
        window: { startTick: nowTick, endTick: nowTick + 100_000 },
        fare: { base: 10, perMinute: 5 },
        jitterTicks: { min: 0, max: 4 },
        dwellTicks: { min: 2, max: 6 },
      };
      return [
        {
          actor: createWorldRider(tripConfig),
          kind: "rider",
          initialPresence: (firstTick) => initialRiderPresence(origin, firstTick),
        },
      ];
    },
  };
}

describe("engine folds a real rider through one trip, a dwell, eviction, and a replacement (GH116, ported from world-engine.test.ts)", () => {
  it("takes a real rider through one trip, a go-home dwell, eviction, and a replacement admission", async () => {
    const h = launch({
      scenarioCast: { members: [], env: CAST_ENV, runSeed: 1 },
      ambientCast: { fixtures: [], spawner: controlledRiderSpawner("cen") },
      checkpoints: deadlineAt(2000),
    });
    await step(h.driver, 1000, 5);
    h.handle.stop();

    const ridersOf = (snap: SimSnapshot) => snap.actors.filter((view) => view.kind === "rider");

    // The first rider is admitted and shows up in the view.
    const firstSeen = h.snapshots.find((snap) => ridersOf(snap).length > 0);
    expect(firstSeen).toBeDefined();
    const firstId = firstSeen ? ridersOf(firstSeen)[0]?.id : undefined;
    expect(firstId).toBeDefined();

    // The first rider's own tap-out (its one trip's exit) is the moment its presence
    // transitions to standing `at` its destination -- the go-home dwell's start.
    const arrivedSnap = h.snapshots.find((snap) =>
      ridersOf(snap).some((view) => view.id === firstId && view.presence.kind === "at"),
    );
    expect(arrivedSnap).toBeDefined();
    const arrivedPresence = arrivedSnap
      ? ridersOf(arrivedSnap).find((view) => view.id === firstId)?.presence
      : undefined;
    const tapOutTick = arrivedPresence?.kind === "at" ? arrivedPresence.fromTick : Number.NaN;

    // A snapshot taken shortly after the tap-out but before the go-home dwell elapses
    // still shows the first rider present, standing `at` its destination.
    const midDwell = h.snapshots.find(
      (snap) =>
        snap.nowTick > tapOutTick &&
        snap.nowTick < tapOutTick + RIDER_GOHOME_DWELL_TICKS &&
        ridersOf(snap).some((view) => view.id === firstId),
    );
    expect(midDwell).toBeDefined();
    const stillAt = midDwell?.actors.find((view) => view.id === firstId)?.presence;
    expect(stillAt?.kind).toBe("at");

    // Eventually the first rider is evicted (gone from every later snapshot)...
    const lastSeenIndex = h.snapshots.findLastIndex((snap) =>
      ridersOf(snap).some((view) => view.id === firstId),
    );
    expect(lastSeenIndex).toBeGreaterThan(-1);
    const afterFirstEvicted = h.snapshots.slice(lastSeenIndex + 1);
    expect(
      afterFirstEvicted.every((snap) => !ridersOf(snap).some((view) => view.id === firstId)),
    ).toBe(true);

    // ...and a genuinely distinct replacement rider is admitted afterward, proving the
    // spawner refilled toward its target once the first rider's slot freed up.
    const replacement = afterFirstEvicted.find((snap) => ridersOf(snap).length > 0);
    expect(replacement).toBeDefined();
    const replacementId = replacement ? ridersOf(replacement)[0]?.id : undefined;
    expect(replacementId).toBeDefined();
    expect(replacementId).not.toBe(firstId);
  });
});

/** A fixture that taps a fare gate at `station` every tick, forever. */
function tapperFixture(id: string, station: string): AmbientFixture {
  const actor: Actor<WorldReading, WorldEnv> = {
    id,
    start: () => 0,
    act: ({ tick }) => {
      const reading: WorldReading = {
        sensor: "fare-gate",
        reading: {
          ts: tick * GAME_SECONDS_PER_TICK,
          card: id,
          station,
          line: "blue",
          direction: "in",
          result: "ok",
          balance: 100,
        },
      };
      const presence: Presence = { kind: "at", node: station, fromTick: tick, untilTick: tick + 1 };
      return { readings: [reading], nextTick: tick + 1, presence };
    },
  };
  return {
    actor,
    kind: "rider",
    initialPresence: (firstTick) => ({
      kind: "at",
      node: station,
      fromTick: 0,
      untilTick: firstTick,
    }),
  };
}

describe("engine bounded cost over a long run (ported from world-engine.test.ts)", () => {
  it("keeps flashes bounded", async () => {
    let maxFlashes = 0;
    const h = launch({
      scenarioCast: { members: [], env: CAST_ENV, runSeed: 1 },
      ambientCast: { fixtures: [tapperFixture("C1", "cen")] },
      checkpoints: deadlineAt(6000),
      setSnapshot: (snap) => {
        maxFlashes = Math.max(maxFlashes, snap.flashes.length);
      },
    });
    await step(h.driver, 5000, 3);
    h.handle.stop();
    // One flash per tick, pruned to the window, so it never grows without bound.
    expect(maxFlashes).toBeLessThanOrEqual(FLASH_WINDOW_TICKS + 1);
  });
});
