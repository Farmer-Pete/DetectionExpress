import { describe, expect, it } from "bun:test";
import { createScorer, type Scorer, type ScorerConfig } from "../sim/correctness";
import { isRawAuthV1 } from "../sim/endpoints/auth/formats/auth-v1";
import type { PipeEvent, PipeMessage } from "../sim/event";
import type { GraphEdge, GraphNode } from "../sim/graph";
import { buildReferenceAlgorithm } from "../sim/scenarios/brute-force-login/reference";
import { bruteForceLogin } from "../sim/scenarios/brute-force-login/scenario";
import type { SimSnapshot } from "../sim/snapshot";
import { RuleError, type TaskAlgorithm } from "../sim/tasks";
import { ManualDriver, type TickDriver } from "./clock";
import { type StartOptions, start } from "./engine";
import {
  BRUTE_FORCE_THRESHOLD,
  CORRECTNESS_W_FN,
  CORRECTNESS_W_FP,
  CORRECTNESS_WINDOW,
  GAME_SECONDS_PER_TICK,
  LEVEL_SEED,
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
  threshold: BRUTE_FORCE_THRESHOLD,
  window: CORRECTNESS_WINDOW,
  wFn: CORRECTNESS_W_FN,
  wFp: CORRECTNESS_W_FP,
};

/** normalize is identity, match never fires: the pipeline runs, nothing scores. */
const idleAlgorithm: TaskAlgorithm = {
  normalize: (raw) => raw,
  match: () => null,
};

async function flush(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    await Promise.resolve();
  }
}

async function step(driver: ManualDriver, ticks: number): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    driver.tick();
    await flush();
  }
}

function ev(id: number, ts: number, payload: unknown = { u: "x" }): PipeEvent {
  return { id, ts, endpoint: "auth-v1", payload };
}

/** The normalized record the reference match reads, after Normalize runs. */
interface ReferenceView {
  user: string;
  sourceIp: string;
  outcome: "success" | "fail";
  id: number;
  ts: number;
  endpoint: string;
}

function isReferenceView(value: unknown): value is ReferenceView {
  return value instanceof Object && "user" in value && "outcome" in value && "id" in value;
}

/** A finite source: yields the given Events, then null (Ingest closes it). */
function scheduleOf(events: PipeEvent[]): () => PipeMessage | null {
  let i = 0;
  return () => (i < events.length ? (events[i++] ?? null) : null);
}

interface LaunchOpts {
  generator?: () => PipeMessage | null;
  algorithm?: TaskAlgorithm;
  scorer?: Scorer;
  setSnapshot?: (snapshot: SimSnapshot) => void;
  onError?: (error: unknown) => void;
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
    scenario: bruteForceLogin,
    algorithm: opts.algorithm ?? idleAlgorithm,
    scorer: opts.scorer ?? createScorer([], SCORER_CONFIG),
    generator: opts.generator ?? scheduleOf([]),
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
        scenario: bruteForceLogin,
        algorithm: idleAlgorithm,
        scorer: createScorer([], SCORER_CONFIG),
        generator: scheduleOf([]),
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
        scenario: bruteForceLogin,
        algorithm: idleAlgorithm,
        scorer: createScorer([], SCORER_CONFIG),
        generator: scheduleOf([]),
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
  // untyped TaskAlgorithm, narrowing at the boundary. The engine feeds it auth-v1
  // payloads, and Normalize produces the record the reference match expects.
  function referenceTaskAlgorithm(): TaskAlgorithm {
    const algo = buildReferenceAlgorithm();
    return {
      normalize: (raw) => (isRawAuthV1(raw) ? algo.normalize(raw) : raw),
      match: (view) => (isReferenceView(view) ? algo.match(view) : null),
    };
  }

  function runReference(): Harness {
    const run = bruteForceLogin.generate(LEVEL_SEED);
    const h = launch({
      generator: scheduleOf(run.events),
      algorithm: referenceTaskAlgorithm(),
      scorer: createScorer(run.attacks, SCORER_CONFIG),
    });
    return h;
  }

  it("reaches full Correctness and finalizes every Attack", async () => {
    const run = bruteForceLogin.generate(LEVEL_SEED);
    const maxDue = Math.max(...run.events.map((e) => Math.round(e.ts / GAME_SECONDS_PER_TICK)));
    const h = runReference();
    await step(h.driver, maxDue + 30);
    await h.handle.whenStopped;
    const snap = h.last();
    expect(snap).toBeDefined();
    if (!snap) return;
    expect(snap.correctness.caught).toBe(run.attacks.length);
    expect(snap.correctness.missed).toBe(0);
    expect(snap.correctness.falseAlerts).toBe(0);
    expect(snap.correctness.rolling).toBe(100);
  });

  it("presents all three edge rates, four node heats, and a drained Backlog", async () => {
    const run = bruteForceLogin.generate(LEVEL_SEED);
    const maxDue = Math.max(...run.events.map((e) => Math.round(e.ts / GAME_SECONDS_PER_TICK)));
    const h = runReference();
    await step(h.driver, maxDue + 30);
    await h.handle.whenStopped;
    const snap = h.last();
    expect(snap).toBeDefined();
    if (!snap) return;
    expect(Object.keys(snap.edges).sort()).toEqual(["e1", "e2", "e3"]);
    expect(Object.keys(snap.nodes).sort()).toEqual(["ingest", "match", "normalize", "sink"]);
    expect(snap.backlog).toBe(0); // sum of all channels, drained at the clean end
  });

  it("produces the same final snapshot when run twice", async () => {
    const run = bruteForceLogin.generate(LEVEL_SEED);
    const maxDue = Math.max(...run.events.map((e) => Math.round(e.ts / GAME_SECONDS_PER_TICK)));
    const first = runReference();
    await step(first.driver, maxDue + 30);
    await first.handle.whenStopped;
    const second = runReference();
    await step(second.driver, maxDue + 30);
    await second.handle.whenStopped;
    expect(second.last()).toEqual(first.last());
  });
});

describe("engine natural completion", () => {
  it("force-publishes exactly one final snapshot at a clean end, then tears down", async () => {
    // The single Event is due at tick 0, so it drains on microtasks with no tick.
    // No normal sample runs; the only publish is the forced final one.
    const h = launch({ generator: scheduleOf([ev(0, 0)]) });
    await h.handle.whenStopped;
    expect(h.snapshots).toHaveLength(1);
    expect(h.last()?.backlog).toBe(0);
  });

  it("shares one builder: a zero-tick forced publish keeps prior rates and heat", async () => {
    // Seven Events spread over ticks 0..6. A normal sample runs at tick 6; the
    // last Event and the marker then drain on microtasks at the same tick, so the
    // forced publish sees zero elapsed ticks and must carry the tick-6 rates/heat
    // while still refreshing Backlog to zero.
    const events = [0, 1, 2, 3, 4, 5, 6].map((t) => ev(t, t * GAME_SECONDS_PER_TICK));
    const h = launch({ generator: scheduleOf(events) });
    await step(h.driver, 6);
    await h.handle.whenStopped;
    const forced = h.snapshots.at(-1);
    const normal = h.snapshots.at(-2);
    expect(forced).toBeDefined();
    expect(normal).toBeDefined();
    if (!forced || !normal) return;
    expect(forced.edges).toEqual(normal.edges); // rates carried, not recomputed
    expect(forced.nodes).toEqual(normal.nodes); // heat carried
    expect(forced.backlog).toBe(0); // but Backlog refreshed
    const anyFlow = Object.values(forced.edges).some((e) => e.inRate > 0);
    expect(anyFlow).toBe(true); // the carried rates are meaningfully non-zero
  });

  it("absorbs a throwing final setSnapshot and still resolves", async () => {
    const h = launch({
      generator: scheduleOf([ev(0, 0)]),
      setSnapshot: () => {
        throw new Error("final snapshot boom");
      },
    });
    await h.handle.whenStopped; // resolves despite the throwing publish
    expect(true).toBe(true);
  });

  it("absorbs both a throwing final setSnapshot and a throwing onError", async () => {
    const h = launch({
      generator: scheduleOf([ev(0, 0)]),
      setSnapshot: () => {
        throw new Error("final snapshot boom");
      },
      onError: () => {
        throw new Error("reporter also boom");
      },
    });
    await h.handle.whenStopped; // still resolves
    expect(true).toBe(true);
  });
});

describe("engine does not force a final publish outside a clean end", () => {
  it("skips the forced publish on a user stop", async () => {
    let nextId = 0;
    // A source that never exhausts: each Event is due far in the future, so Ingest
    // sleeps and the run never completes on its own.
    const h = launch({ generator: () => ev(nextId++, 10_000) });
    await step(h.driver, 7); // a couple of normal samples run
    const afterStop = h.snapshots.length;
    expect(afterStop).toBeGreaterThan(0);
    h.handle.stop();
    await h.handle.whenStopped;
    expect(h.snapshots.length).toBe(afterStop); // the continuation published nothing
  });

  it("skips the forced publish on a task failure and reports it", async () => {
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
      onError: (error) => errors.push(error),
    });
    await h.handle.whenStopped;
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(RuleError);
    expect(h.snapshots).toHaveLength(0); // no normal sample, and no forced publish
  });
});

describe("engine stop", () => {
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
      scenario: bruteForceLogin,
      algorithm: idleAlgorithm,
      scorer: createScorer([], SCORER_CONFIG),
      generator: () => ev(nextId++, 10_000),
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
    expect(calls).toBe(1); // failed on the first publish, then stopped
    await h.handle.whenStopped;
  });
});
