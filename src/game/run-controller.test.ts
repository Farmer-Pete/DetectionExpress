import { describe, expect, it } from "vitest";
import type { Checkpoint, GeneratedRun, Scenario } from "../sim/scenario";
import type { ServiceRate } from "../sim/service-governor";
import type { SimSnapshot } from "../sim/snapshot";
import type { LoadedAlgorithm } from "./algorithm";
import type { EngineHandle, StartOptions } from "./engine";
import {
  createRunController,
  type ProfilerWorkerLike,
  type RuleErrorInfo,
  type RunControllerDeps,
  type ServiceRateHandle,
} from "./run-controller";

const algo: LoadedAlgorithm = { normalize: (raw) => raw, match: () => [] };

const emptyRun: GeneratedRun = { events: [], attacks: [], checkpoints: [] };
const scenario: Scenario = { id: "test", briefing: "test briefing", generate: () => emptyRun };

const graph = { nodes: [], edges: [] };

const FIXED_RATE: ServiceRate = { num: 7, den: 1 };

/** A profiler seam that resolves at once with a fixed rate: no worker, no timing. */
function fixedServiceRate(rate: ServiceRate = FIXED_RATE): ServiceRateHandle {
  return { rate: Promise.resolve(rate), cancel: () => undefined };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}

function fakeHandle(whenStopped: Promise<void> = Promise.resolve()): EngineHandle {
  return { stop: () => undefined, whenStopped };
}

/** Base deps with harmless getters; each test overrides what it exercises. */
function baseDeps(over: Partial<RunControllerDeps>): RunControllerDeps {
  return {
    scenario,
    getGraph: () => graph,
    getSource: () => "source",
    getSeed: () => 1,
    setSnapshot: () => undefined,
    setError: () => undefined,
    loadAlgorithm: async () => algo,
    resolveServiceRate: () => fixedServiceRate(),
    start: () => fakeHandle(),
    ...over,
  };
}

describe("run controller", () => {
  it("drops a stale overlapping run and starts only the newest", async () => {
    const started: string[] = [];
    const loads = [deferred<LoadedAlgorithm>(), deferred<LoadedAlgorithm>()];
    let call = 0;
    const controller = createRunController(
      baseDeps({
        loadAlgorithm: () => loads[call++]?.promise ?? Promise.resolve(algo),
        start: (_options: StartOptions) => {
          started.push("engine");
          return fakeHandle();
        },
      }),
    );
    controller.run(); // generation 1, load 0 pending
    controller.run(); // generation 2, load 1 pending
    loads[0]?.resolve(algo); // resolves stale generation 1
    await flush();
    expect(started).toHaveLength(0); // the stale run started nothing
    loads[1]?.resolve(algo); // resolves the current generation 2
    await flush();
    expect(started).toHaveLength(1); // only the newest run started
  });

  it("drops a load that resolves after dispose, silently", async () => {
    const errors: (RuleErrorInfo | null)[] = [];
    let starts = 0;
    const load = deferred<LoadedAlgorithm>();
    const controller = createRunController(
      baseDeps({
        loadAlgorithm: () => load.promise,
        setError: (error) => errors.push(error),
        start: () => {
          starts += 1;
          return fakeHandle();
        },
      }),
    );
    controller.run();
    controller.dispose();
    load.resolve(algo);
    await flush();
    expect(starts).toBe(0); // nothing started after dispose
    expect(errors).toHaveLength(0); // dispose is silent
  });

  it("reports a synchronous start throw as a start-phase error", async () => {
    const phases: string[] = [];
    const controller = createRunController(
      baseDeps({
        setError: (e) => {
          if (e) phases.push(e.phase);
        },
        start: () => {
          throw new Error("start boom");
        },
      }),
    );
    controller.run();
    await flush();
    expect(phases).toContain("start");
  });

  it("reports a load failure as a load-phase error", async () => {
    const phases: string[] = [];
    const controller = createRunController(
      baseDeps({
        setError: (e) => {
          if (e) phases.push(e.phase);
        },
        loadAlgorithm: async () => {
          throw new Error("bad syntax");
        },
      }),
    );
    controller.run();
    await flush();
    expect(phases).toContain("load");
  });

  it("ignores a stale whenStopped completion from a superseded run", async () => {
    let finishes = 0;
    const stale = deferred<void>();
    const handles = [fakeHandle(stale.promise), fakeHandle(Promise.resolve())];
    let call = 0;
    const controller = createRunController(
      baseDeps({
        start: () => handles[call++] ?? fakeHandle(),
        onFinished: () => {
          finishes += 1;
        },
      }),
    );
    controller.run(); // generation 1, whenStopped still pending
    await flush();
    controller.run(); // generation 2, whenStopped already resolved -> onFinished
    await flush();
    stale.resolve(); // generation 1 completes late -> must be ignored
    await flush();
    expect(finishes).toBe(1); // only the live run's completion counted
  });

  it("passes the generated checkpoints into start unchanged (M2 seam 10)", async () => {
    const checkpoints: Checkpoint[] = [
      { atTick: 300, clearsThroughWave: 0 },
      { atTick: 700, clearsThroughWave: 1 },
    ];
    const run: GeneratedRun = { events: [], attacks: [], checkpoints };
    const seen: StartOptions[] = [];
    const controller = createRunController(
      baseDeps({
        scenario: { id: "waved", briefing: "b", generate: () => run },
        start: (options) => {
          seen.push(options);
          return fakeHandle();
        },
      }),
    );
    controller.run();
    await flush();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.checkpoints).toBe(checkpoints); // the same array, untouched
  });

  it("injects the profiled service rate into start (M2)", async () => {
    const seen: StartOptions[] = [];
    const controller = createRunController(
      baseDeps({
        resolveServiceRate: () => fixedServiceRate({ num: 9, den: 4 }),
        start: (options) => {
          seen.push(options);
          return fakeHandle();
        },
      }),
    );
    controller.run();
    await flush();
    expect(seen[0]?.serviceRate).toEqual({ num: 9, den: 4 });
  });

  it("cancels a stale profiler worker when a newer run supersedes it (M2)", async () => {
    const cancels: number[] = [];
    const rates = [deferred<ServiceRate>(), deferred<ServiceRate>()];
    let call = 0;
    const controller = createRunController(
      baseDeps({
        resolveServiceRate: () => {
          const index = call++;
          return {
            rate: rates[index]?.promise ?? Promise.resolve(FIXED_RATE),
            cancel: () => cancels.push(index),
          };
        },
      }),
    );
    controller.run(); // generation 1: its measurement is still pending
    await flush();
    controller.run(); // generation 2: supersedes 1, cancelling its worker
    await flush();
    expect(cancels).toContain(0); // the stale generation-1 worker was terminated
  });

  it("clears the error and resets the snapshot on a fresh run", async () => {
    const snapshots: SimSnapshot[] = [];
    let cleared = false;
    const controller = createRunController(
      baseDeps({
        setSnapshot: (snapshot) => snapshots.push(snapshot),
        setError: (error) => {
          if (error === null) cleared = true;
        },
      }),
    );
    controller.run();
    await flush();
    expect(cleared).toBe(true);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.correctness.rolling).toBe(100); // emptySnapshot reset
  });

  it("reuses the cached rate for an unchanged source, and re-profiles a changed one (M2 review 6)", async () => {
    let source = "source-A";
    let calls = 0;
    const controller = createRunController(
      baseDeps({
        getSource: () => source,
        resolveServiceRate: () => {
          calls += 1;
          return fixedServiceRate();
        },
      }),
    );
    controller.run();
    await flush();
    controller.run(); // same source: the cached rate is reused, no re-profile
    await flush();
    expect(calls).toBe(1);
    source = "source-B"; // a changed source invalidates the key
    controller.run();
    await flush();
    expect(calls).toBe(2);
  });
});

/** Set `document.hidden` so the defer-and-retry path can be driven deterministically. */
function setHidden(hidden: boolean): void {
  Object.defineProperty(document, "hidden", { configurable: true, value: hidden });
}

/** A profiler worker the test drives by hand: it records posts and emits outcomes. */
class FakeProfilerWorker implements ProfilerWorkerLike {
  private messageHandler: ((event: MessageEvent) => void) | null = null;
  private errorHandler: ((event: ErrorEvent) => void) | null = null;
  posted: { source: string; hidden: boolean }[] = [];
  terminated = false;

  postMessage(message: { source: string; hidden: boolean }): void {
    this.posted.push(message);
  }
  terminate(): void {
    this.terminated = true;
  }
  addEventListener(type: "message", handler: (event: MessageEvent) => void): void;
  addEventListener(type: "error", handler: (event: ErrorEvent) => void): void;
  addEventListener(
    type: "message" | "error",
    handler: ((event: MessageEvent) => void) & ((event: ErrorEvent) => void),
  ): void {
    if (type === "message") {
      this.messageHandler = handler;
    } else {
      this.errorHandler = handler;
    }
  }
  emitMessage(data: unknown): void {
    this.messageHandler?.(new MessageEvent("message", { data }));
  }
  emitError(error: unknown): void {
    this.errorHandler?.(new ErrorEvent("error", { error }));
  }
}

const OK_OUTCOME = { ok: true, result: { codePerAnchor: 2, oracleScore: 1 } };

/** Deps that exercise the real worker seam: no `resolveServiceRate` shortcut. */
function workerDeps(over: Partial<RunControllerDeps>): RunControllerDeps {
  return {
    scenario,
    getGraph: () => graph,
    getSource: () => "source",
    getSeed: () => 1,
    setSnapshot: () => undefined,
    setError: () => undefined,
    loadAlgorithm: async () => algo,
    start: () => fakeHandle(),
    ...over,
  };
}

describe("run controller worker seam (M2 review 1, 2, 5)", () => {
  it("reports a non-ok worker outcome as a clean profile error, without hanging", async () => {
    const workers: FakeProfilerWorker[] = [];
    const phases: string[] = [];
    let started = 0;
    const controller = createRunController(
      workerDeps({
        spawnProfilerWorker: () => {
          const worker = new FakeProfilerWorker();
          workers.push(worker);
          return worker;
        },
        start: () => {
          started += 1;
          return fakeHandle();
        },
        setError: (e) => {
          if (e) phases.push(e.phase);
        },
      }),
    );
    controller.run();
    await flush();
    workers[0]?.emitMessage({ ok: false, error: "match must return an Alert" });
    await flush();
    expect(phases).toContain("profile");
    expect(started).toBe(0);
    expect(workers[0]?.terminated).toBe(true);
  });

  it("rejects and terminates cleanly on an async worker error event", async () => {
    const workers: FakeProfilerWorker[] = [];
    const phases: string[] = [];
    const controller = createRunController(
      workerDeps({
        spawnProfilerWorker: () => {
          const worker = new FakeProfilerWorker();
          workers.push(worker);
          return worker;
        },
        setError: (e) => {
          if (e) phases.push(e.phase);
        },
      }),
    );
    controller.run();
    await flush();
    workers[0]?.emitError(new Error("worker boom"));
    await flush();
    expect(phases).toContain("profile");
    expect(workers[0]?.terminated).toBe(true);
  });

  it("defers a hidden-tab outcome and re-profiles on visibility, not a hard error", async () => {
    const workers: FakeProfilerWorker[] = [];
    const errors: (RuleErrorInfo | null)[] = [];
    const rates: number[] = [];
    setHidden(true);
    const controller = createRunController(
      workerDeps({
        spawnProfilerWorker: () => {
          const worker = new FakeProfilerWorker();
          workers.push(worker);
          return worker;
        },
        start: (options) => {
          rates.push(options.serviceRate.num / options.serviceRate.den);
          return fakeHandle();
        },
        setError: (e) => errors.push(e),
      }),
    );
    controller.run();
    await flush();
    workers[0]?.emitMessage({ ok: false, deferred: "hidden" }); // hidden: hold, do not fail
    await flush();
    expect(errors.filter((e) => e !== null)).toHaveLength(0); // no hard error yet
    expect(workers).toHaveLength(1); // still waiting; no retry spawned

    setHidden(false);
    document.dispatchEvent(new Event("visibilitychange")); // tab visible: re-profile
    await flush();
    expect(workers).toHaveLength(2); // a fresh measurement was spawned
    workers[1]?.emitMessage(OK_OUTCOME);
    await flush();
    expect(rates).toHaveLength(1); // the re-profile resolved and the run started
    setHidden(false); // leave the environment visible for later tests
  });

  it("falls back to the main thread when the worker cannot be spawned", async () => {
    let fallbackCalls = 0;
    const rates: number[] = [];
    const controller = createRunController(
      workerDeps({
        spawnProfilerWorker: () => {
          throw new Error("module Worker forbidden here");
        },
        mainThreadResolveServiceRate: () => {
          fallbackCalls += 1;
          return { rate: Promise.resolve({ num: 3, den: 1 }), cancel: () => undefined };
        },
        start: (options) => {
          rates.push(options.serviceRate.num / options.serviceRate.den);
          return fakeHandle();
        },
      }),
    );
    controller.run();
    await flush();
    expect(fallbackCalls).toBe(1);
    expect(rates).toEqual([3]);
  });
});
