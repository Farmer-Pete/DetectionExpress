import { describe, expect, it } from "bun:test";
import type { Attack } from "../sim/attack";
import { createScorer, type Scorer, type ScorerConfig } from "../sim/correctness";
import { isRawKioskV1 } from "../sim/endpoints/kiosk/formats/kiosk-v1";
import type { PipeEvent } from "../sim/event";
import type { GraphEdge, GraphNode } from "../sim/graph";
import type { Checkpoint } from "../sim/scenario";
import { buildReferenceAlgorithm } from "../sim/scenarios/kiosk-pin-attack/reference";
import { kioskPinAttack } from "../sim/scenarios/kiosk-pin-attack/scenario";
import type { ServiceRate } from "../sim/service-governor";
import type { SimSnapshot } from "../sim/snapshot";
import { RuleError, type TaskAlgorithm } from "../sim/tasks";
import { ManualDriver, type TickDriver } from "./clock";
import { type StartOptions, start } from "./engine";
import {
  CHANNEL_CAP,
  CORRECTNESS_W_FN,
  CORRECTNESS_W_FP,
  CORRECTNESS_WINDOW,
  GAME_SECONDS_PER_TICK,
  LEVEL_SEED,
  PIN_BRUTE_FORCE_THRESHOLD,
} from "./tuning";

const NODES: GraphNode[] = [
  { id: "ingest", kind: "ingest" },
  { id: "normalize", kind: "normalize" },
  { id: "match", kind: "match" },
  { id: "sink", kind: "sink" },
];
const EDGES: GraphEdge[] = [
  { id: "e1", source: "ingest", target: "normalize" },
  { id: "e2", source: "normalize", target: "match" },
  { id: "e3", source: "match", target: "sink" },
];

const SCORER_CONFIG: ScorerConfig = {
  threshold: PIN_BRUTE_FORCE_THRESHOLD,
  window: CORRECTNESS_WINDOW,
  wFn: CORRECTNESS_W_FN,
  wFp: CORRECTNESS_W_FP,
};

/** A rate so fast the governor never sleeps: the pipeline drains as fast as it fills. */
const FAST_RATE: ServiceRate = { num: 1_000_000, den: 1 };

/** normalize is identity, match never fires: the pipeline runs, nothing scores. */
const idleAlgorithm: TaskAlgorithm = {
  normalize: (raw) => raw,
  match: () => null,
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

/** The normalized record the reference match reads, after Normalize runs. */
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
    getGraph: () => ({ nodes: NODES, edges: EDGES }),
    setSnapshot: opts.setSnapshot ?? ((snapshot) => snapshots.push(snapshot)),
    algorithm: opts.algorithm ?? idleAlgorithm,
    scorer: opts.scorer ?? createScorer([], SCORER_CONFIG),
    generator: opts.generator ?? scheduleOf([]),
    serviceRate: opts.serviceRate ?? FAST_RATE,
    checkpoints: opts.checkpoints ?? [],
    driver,
    bindVisibility: () => () => undefined,
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
}

describe("engine start guards", () => {
  it("throws on an invalid graph and allocates nothing", () => {
    const driver = new SpyDriver();
    expect(() =>
      start({
        getGraph: () => ({ nodes: [{ id: "x", kind: "detect" }], edges: [] }),
        setSnapshot: () => undefined,
        algorithm: idleAlgorithm,
        scorer: createScorer([], SCORER_CONFIG),
        generator: scheduleOf([]),
        serviceRate: FAST_RATE,
        checkpoints: [],
        driver,
        bindVisibility: () => () => undefined,
      }),
    ).toThrow(/unknown/i);
    expect(driver.started).toBe(false); // the Clock was never constructed
  });

  it("tears down after a setup failure past allocation", () => {
    const driver = new SpyDriver();
    const snapshots: SimSnapshot[] = [];
    expect(() =>
      start({
        getGraph: () => ({ nodes: NODES, edges: EDGES }),
        setSnapshot: (snapshot) => snapshots.push(snapshot),
        algorithm: idleAlgorithm,
        scorer: createScorer([], SCORER_CONFIG),
        generator: scheduleOf([]),
        serviceRate: FAST_RATE,
        checkpoints: [],
        driver,
        bindVisibility: () => {
          throw new Error("visibility bind boom");
        },
      }),
    ).toThrow(/visibility bind boom/);
    expect(driver.started).toBe(true); // the Clock started it
    expect(driver.stopped).toBe(true); // teardown stopped it again
    expect(snapshots).toHaveLength(0); // nothing published
  });
});

describe("engine integration with the reference Algorithm", () => {
  // Adapt the reference twin (typed to its concrete records) to the engine's
  // untyped TaskAlgorithm, narrowing at the boundary. The engine feeds it kiosk-v1
  // payloads, and Normalize produces the record the reference match expects.
  function referenceTaskAlgorithm(): TaskAlgorithm {
    const algo = buildReferenceAlgorithm();
    return {
      normalize: (raw) => (isRawKioskV1(raw) ? algo.normalize(raw) : raw),
      match: (view) => (isReferenceView(view) ? algo.match(view) : null),
    };
  }

  function runReference(): { harness: Harness; finalTick: number } {
    const run = kioskPinAttack.generate(LEVEL_SEED);
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
    const run = kioskPinAttack.generate(LEVEL_SEED);
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

  it("presents all three edge rates, four node heats, and a drained Backlog at the win", async () => {
    const { harness, finalTick } = runReference();
    await step(harness.driver, finalTick + 2, 300);
    await harness.handle.whenStopped;
    const snap = harness.last();
    expect(snap).toBeDefined();
    if (!snap) return;
    expect(Object.keys(snap.edges).sort()).toEqual(["e1", "e2", "e3"]);
    expect(Object.keys(snap.nodes).sort()).toEqual(["ingest", "match", "normalize", "sink"]);
    expect(snap.backlog).toBe(0); // sum of all channels, drained by the deadline
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

  it("force-publishes exactly one terminal frame at the win, carrying prior rates", async () => {
    // Seven Events over ticks 0..6, then a distant deadline. A normal sample and
    // the terminal forced publish must agree on the carried rates and heat while
    // the terminal frame flips status to won.
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
    expect(forced.backlog).toBe(0);
    const anyFlow = Object.values(forced.edges).some((e) => e.inRate > 0);
    expect(anyFlow).toBe(true); // the carried rates are meaningfully non-zero
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
      match: () => {
        throw new Error("boom in match");
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
        match: () => {
          throw new Error("boom in match");
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
      getGraph: () => ({ nodes: NODES, edges: EDGES }),
      setSnapshot: () => undefined,
      algorithm: idleAlgorithm,
      scorer: createScorer([], SCORER_CONFIG),
      generator: () => ev(nextId++, 10_000),
      serviceRate: FAST_RATE,
      checkpoints: [],
      driver,
      bindVisibility: () => () => undefined,
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
  it("saturates the Backlog near 2 * CHANNEL_CAP with the Match->Sink channel near empty", async () => {
    // A flood of Events due now, against a slow service rate. The two upstream
    // channels fill to cap; the Match->Sink channel stays near empty because the
    // Sink drains at once, so the total Backlog tops out near 2 * CHANNEL_CAP.
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
    expect(snap.backlog).toBeGreaterThanOrEqual(ceiling - 2);
    expect(snap.backlog).toBeLessThanOrEqual(ceiling + 2); // not near 3*CAP: e3 stays empty
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
    expect(h.last()?.failureReason).toBe("backlog");
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

  it("fails at the deadline with a slow rule still holding Backlog", async () => {
    const events = [0, 1, 2, 3, 4].map((t) => ev(t, t * GAME_SECONDS_PER_TICK));
    const h = launch({
      generator: scheduleOf(events),
      serviceRate: { num: 1, den: 20 }, // 0.05 records per tick: cannot keep up
      checkpoints: deadlineAt(40),
    });
    await step(h.driver, 41);
    await h.handle.whenStopped;
    expect(h.last()?.status).toBe("failed");
    expect(h.last()?.failureReason).toBe("backlog");
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
    expect(last.failureReason).toBe("backlog");
  });
});

describe("engine Correctness settles at a checkpoint (M2 seam 11)", () => {
  it("fails on Correctness via advanceTo, with no Event in the gap and no end of stream", async () => {
    // One Attack whose window closes at ts 10 (tick 5). The rule never alerts, so
    // the Attack stays pending; every Event finishes before the checkpoint, so the
    // Backlog is clear. The checkpoint at tick 10 sits in a drain gap with no later
    // Event: only scorer.advanceTo can settle the miss, dropping Correctness.
    const attack: Attack = {
      id: 1,
      account: "root",
      reason: "pin_brute_force",
      window: { startTs: 0, endTs: 10 },
      eventIds: [0, 1, 2, 3, 4],
    };
    // Events at ts 0..8 (ticks 0..4), all before the window close and the gap.
    const events = [0, 1, 2, 3, 4].map((k) => ev(k, k * GAME_SECONDS_PER_TICK));
    const h = launch({
      generator: scheduleOf(events),
      scorer: createScorer([attack], SCORER_CONFIG),
      serviceRate: FAST_RATE, // Backlog clears well before the checkpoint
      checkpoints: deadlineAt(10),
    });
    await step(h.driver, 11);
    await h.handle.whenStopped;
    expect(h.last()?.status).toBe("failed");
    expect(h.last()?.failureReason).toBe("correctness");
    expect(h.last()?.correctness.missed).toBe(1); // settled by advanceTo, not EOS
  });
});
