import { describe, expect, it } from "vitest";
import type { Checkpoint, GeneratedRun, Scenario, Wave } from "../sim/scenario";
import type { ServiceRate } from "../sim/service-governor";
import type { SimSnapshot } from "../sim/snapshot";
import type { AlgorithmSource, LoadedAlgorithm, LoadTarget } from "./algorithm";
import type { EngineHandle, StartOptions } from "./engine";
import {
  createRunController,
  type ProfilerWorkerLike,
  type RuleErrorInfo,
  type RunControllerDeps,
  type ServiceRateHandle,
} from "./run-controller";

const algo: LoadedAlgorithm = { normalize: (raw) => raw, detect: () => [] };

const emptyRun: GeneratedRun = { events: [], attacks: [], checkpoints: [], waves: [] };
const scenario: Scenario = { id: "test", briefing: "test briefing", generate: () => emptyRun };

const graph = { nodes: [], edges: [] };

/** A source-mode input, the in-game editor's path — the default across most tests. */
function sourceMode(source = "source"): AlgorithmSource {
  return { kind: "source", source };
}

/** A url-mode input, local-IDE mode. `url = path + "?v=" + version`, as the plan sets it. */
function urlMode(path: string, version: number): AlgorithmSource {
  return { kind: "url", path, version, url: `${path}?v=${version}` };
}

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
  return {
    stop: () => undefined,
    pause: () => undefined,
    resume: () => undefined,
    setSpeed: () => undefined,
    whenStopped,
  };
}

/** Base deps with harmless getters; each test overrides what it exercises. */
function baseDeps(over: Partial<RunControllerDeps>): RunControllerDeps {
  return {
    scenario,
    getGraph: () => graph,
    getAlgorithmSource: () => sourceMode(),
    getSeed: () => 1,
    setSnapshot: () => undefined,
    setError: () => undefined,
    setRunPending: () => undefined,
    loadAlgorithm: async () => algo,
    resolveServiceRate: () => fixedServiceRate(),
    start: () => fakeHandle(),
    ...over,
  };
}

/** A fake engine handle whose stop calls are counted, with a controllable completion. */
function spyHandle(whenStopped: Promise<void> = new Promise(() => undefined)): {
  handle: EngineHandle;
  stops: number;
} {
  const state = { stops: 0 };
  const handle: EngineHandle = {
    stop: () => {
      state.stops += 1;
    },
    pause: () => undefined,
    resume: () => undefined,
    setSpeed: () => undefined,
    whenStopped,
  };
  return {
    handle,
    get stops() {
      return state.stops;
    },
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

  it("drops an OLDER load that resolves AFTER the newer one, never starting or profiling it (M2a)", async () => {
    const started: string[] = [];
    const profiles: number[] = [];
    const loads = [deferred<LoadedAlgorithm>(), deferred<LoadedAlgorithm>()];
    let loadCall = 0;
    let profileCall = 0;
    const controller = createRunController(
      baseDeps({
        loadAlgorithm: () => loads[loadCall++]?.promise ?? Promise.resolve(algo),
        resolveServiceRate: () => {
          profiles.push(profileCall++);
          return fixedServiceRate();
        },
        start: () => {
          started.push("engine");
          return fakeHandle();
        },
      }),
    );
    controller.run(); // generation 1 (the OLDER run), load 0 pending
    controller.run(); // generation 2 (the NEWER run), load 1 pending
    loads[1]?.resolve(algo); // the newer run's load resolves FIRST
    await flush();
    loads[0]?.resolve(algo); // the older run's load resolves LATER — the guard must drop it
    await flush();
    expect(started).toHaveLength(1); // only the newer run started the engine
    expect(profiles).toEqual([0]); // the older run never even reached the profiler
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
    const run: GeneratedRun = { events: [], attacks: [], checkpoints, waves: [] };
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

  it("passes the generated waves into start unchanged", async () => {
    const waves: Wave[] = [{ startTick: 120, durationTicks: 240, eventsPerTick: 5 }];
    const run: GeneratedRun = { events: [], attacks: [], checkpoints: [], waves };
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
    expect(seen[0]?.waves).toBe(waves); // the same array, untouched
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

  it("keeps the live engine running when a later load fails (dry-run before teardown)", async () => {
    const live = spyHandle();
    const phases: string[] = [];
    let source = "good";
    let loadCall = 0;
    const controller = createRunController(
      baseDeps({
        getAlgorithmSource: () => sourceMode(source),
        loadAlgorithm: async () => {
          if (loadCall++ === 0) return algo;
          throw new Error("bad syntax");
        },
        start: () => live.handle,
        setError: (e) => {
          if (e) phases.push(e.phase);
        },
      }),
    );
    controller.run(); // first run starts the live engine
    await flush();
    source = "broken";
    controller.run(); // a broken edit: the load fails
    await flush();
    expect(phases).toContain("load");
    expect(live.stops).toBe(0); // the live engine was never stopped
  });

  it("keeps the live engine running when a later profile fails (dry-run before teardown)", async () => {
    const live = spyHandle();
    const phases: string[] = [];
    let source = "good";
    let profileCall = 0;
    const controller = createRunController(
      baseDeps({
        getAlgorithmSource: () => sourceMode(source),
        resolveServiceRate: () => {
          if (profileCall++ === 0) return fixedServiceRate();
          return { rate: Promise.reject(new Error("profile boom")), cancel: () => undefined };
        },
        start: () => live.handle,
        setError: (e) => {
          if (e) phases.push(e.phase);
        },
      }),
    );
    controller.run(); // first run starts the live engine and caches its rate
    await flush();
    source = "changed"; // a new source, so the rate is re-measured and fails
    controller.run();
    await flush();
    expect(phases).toContain("profile");
    expect(live.stops).toBe(0); // the live engine was never stopped
  });

  it("stops the old engine, THEN starts the new one, on a successful validate", async () => {
    const events: string[] = [];
    const old = spyHandle();
    let call = 0;
    const controller = createRunController(
      baseDeps({
        getAlgorithmSource: () => sourceMode(`source-${call}`),
        start: () => {
          if (call++ === 0) {
            events.push("start-old");
            const handle: EngineHandle = {
              stop: () => events.push("stop-old"),
              pause: () => undefined,
              resume: () => undefined,
              setSpeed: () => undefined,
              whenStopped: new Promise(() => undefined),
            };
            return handle;
          }
          events.push("start-new");
          return old.handle;
        },
      }),
    );
    controller.run();
    await flush();
    controller.run();
    await flush();
    expect(events).toEqual(["start-old", "stop-old", "start-new"]);
  });

  it("keeps ownership of the live engine after a failed Apply, so a later good Apply stops it once", async () => {
    const live = spyHandle();
    const snapshots: SimSnapshot[] = [];
    let source = "good";
    let loadCall = 0;
    const controller = createRunController(
      baseDeps({
        getAlgorithmSource: () => sourceMode(source),
        loadAlgorithm: async () => {
          // first (live) load ok, second (bad Apply) throws, third (good Apply) ok
          if (loadCall++ === 1) throw new Error("bad syntax");
          return algo;
        },
        start: () => live.handle,
        setSnapshot: (s) => snapshots.push(s),
      }),
    );
    controller.run(); // start the live engine
    await flush();
    expect(snapshots).toHaveLength(1);
    source = "broken";
    controller.run(); // failed Apply: load throws
    await flush();
    expect(snapshots).toHaveLength(1); // the snapshot did not change
    expect(live.stops).toBe(0); // the live engine kept running
    source = "good-again";
    controller.run(); // good Apply: commit stops the original handle exactly once
    await flush();
    expect(live.stops).toBe(1);
  });

  it("keeps ownership of the live engine after a failed Apply, so a later dispose stops it once", async () => {
    const live = spyHandle();
    let source = "good";
    let loadCall = 0;
    const controller = createRunController(
      baseDeps({
        getAlgorithmSource: () => sourceMode(source),
        loadAlgorithm: async () => {
          if (loadCall++ === 1) throw new Error("bad syntax");
          return algo;
        },
        start: () => live.handle,
      }),
    );
    controller.run();
    await flush();
    source = "broken";
    controller.run(); // failed Apply
    await flush();
    expect(live.stops).toBe(0);
    controller.dispose(); // dispose still owns and stops the live engine
    expect(live.stops).toBe(1);
  });

  it("keeps ownership of the live engine when a commit-phase setup throw happens", async () => {
    // A throw inside the commit block BEFORE `engine?.stop()` (a bad
    // `scenario.generate`/`createScorer`) is a "setup" phase error. The live engine
    // has not been stopped, so the controller must keep its reference, not null it.
    const live = spyHandle();
    let source = "good";
    let generateCall = 0;
    const throwingScenario: Scenario = {
      id: "test",
      briefing: "b",
      generate: () => {
        if (generateCall++ === 1) {
          throw new Error("bad scenario build"); // the second run's commit setup throws
        }
        return emptyRun;
      },
    };
    const errors: RuleErrorInfo[] = [];
    const controller = createRunController(
      baseDeps({
        scenario: throwingScenario,
        getAlgorithmSource: () => sourceMode(source),
        start: () => live.handle,
        setError: (error) => {
          if (error) {
            errors.push(error);
          }
        },
      }),
    );
    controller.run(); // start the live engine
    await flush();
    expect(live.stops).toBe(0);
    source = "changed"; // a fresh Apply; its commit reaches generate, which throws
    controller.run();
    await flush();
    expect(errors.at(-1)?.phase).toBe("setup"); // the commit-phase setup error surfaced
    expect(live.stops).toBe(0); // the still-live engine was never stopped by the failed Apply
    controller.dispose(); // the controller still owns it, so dispose stops it exactly once
    expect(live.stops).toBe(1);
  });

  it("fires onFinished when the live engine completes during a failing preflight (handle identity)", async () => {
    let finishes = 0;
    const done = deferred<void>();
    const live = spyHandle(done.promise);
    let source = "good";
    let loadCall = 0;
    const controller = createRunController(
      baseDeps({
        getAlgorithmSource: () => sourceMode(source),
        loadAlgorithm: async () => {
          if (loadCall++ === 1) throw new Error("bad syntax");
          return algo;
        },
        start: () => live.handle,
        onFinished: () => {
          finishes += 1;
        },
      }),
    );
    controller.run(); // the live engine starts
    await flush();
    source = "broken";
    controller.run(); // a dry-run that fails at load, bumping the generation
    await flush();
    done.resolve(); // the live engine completes naturally during/after the failed preflight
    await flush();
    expect(finishes).toBe(1); // completion keys on handle identity, not the generation
  });

  it("drives runPending true then false on a successful run", async () => {
    const pending: boolean[] = [];
    const controller = createRunController(
      baseDeps({
        setRunPending: (v) => pending.push(v),
      }),
    );
    controller.run();
    await flush();
    expect(pending).toEqual([true, false]);
  });

  it("clears runPending when a run fails at load", async () => {
    const pending: boolean[] = [];
    const controller = createRunController(
      baseDeps({
        loadAlgorithm: async () => {
          throw new Error("bad syntax");
        },
        setRunPending: (v) => pending.push(v),
      }),
    );
    controller.run();
    await flush();
    expect(pending).toEqual([true, false]);
  });

  it("does not let a superseded run clear a newer run's runPending", async () => {
    const pending: boolean[] = [];
    const loads = [deferred<LoadedAlgorithm>(), deferred<LoadedAlgorithm>()];
    let call = 0;
    const controller = createRunController(
      baseDeps({
        loadAlgorithm: () => loads[call++]?.promise ?? Promise.resolve(algo),
        setRunPending: (v) => pending.push(v),
      }),
    );
    controller.run(); // generation 1, pending true
    controller.run(); // generation 2, pending true
    loads[0]?.resolve(algo); // the stale generation-1 load resolves
    await flush();
    // the stale run must NOT have cleared the flag the live run owns
    expect(pending).toEqual([true, true]);
    loads[1]?.resolve(algo); // the live generation-2 run resolves and clears it
    await flush();
    expect(pending).toEqual([true, true, false]);
  });

  it("clears runPending when dispose interrupts an in-flight run", async () => {
    const pending: boolean[] = [];
    const load = deferred<LoadedAlgorithm>();
    const controller = createRunController(
      baseDeps({
        loadAlgorithm: () => load.promise,
        setRunPending: (v) => pending.push(v),
      }),
    );
    controller.run(); // pending true, load still in flight
    await flush();
    expect(pending).toEqual([true]);
    controller.dispose(); // dispose clears it directly
    expect(pending).toEqual([true, false]);
    load.resolve(algo); // the in-flight run resolves after dispose, and stays silent
    await flush();
    expect(pending).toEqual([true, false]); // the guarded finally did not clear it again
  });

  it("delegates setFrozen to the live engine handle (pause then resume)", async () => {
    const calls: string[] = [];
    const handle: EngineHandle = {
      stop: () => undefined,
      pause: () => calls.push("pause"),
      resume: () => calls.push("resume"),
      setSpeed: () => undefined,
      whenStopped: new Promise(() => undefined),
    };
    const controller = createRunController(baseDeps({ start: () => handle }));
    controller.run();
    await flush();
    controller.setFrozen(true);
    expect(calls).toEqual(["pause"]);
    controller.setFrozen(false);
    expect(calls).toEqual(["pause", "resume"]);
  });

  it("setFrozen is a safe no-op when no engine is live", () => {
    const controller = createRunController(baseDeps({}));
    expect(() => controller.setFrozen(true)).not.toThrow();
  });

  it("reapplies the retained freeze on the next startEngine, so a replacement run inherits it", async () => {
    const pauses: number[] = [];
    let call = 0;
    const controller = createRunController(
      baseDeps({
        getAlgorithmSource: () => sourceMode(`source-${call}`),
        start: () => {
          const index = call++;
          return {
            stop: () => undefined,
            pause: () => pauses.push(index),
            resume: () => undefined,
            setSpeed: () => undefined,
            whenStopped: new Promise(() => undefined),
          };
        },
      }),
    );
    controller.run(); // first engine (index 0) starts
    await flush();
    controller.setFrozen(true); // freezes the live engine -> pause index 0
    controller.run(); // a replacement run (Apply/hot-reload) builds a fresh clock
    await flush();
    expect(pauses).toEqual([0, 1]); // the new engine inherited the freeze on start
  });

  it("delegates setSpeed to the live engine handle", async () => {
    const speeds: number[] = [];
    const handle: EngineHandle = {
      stop: () => undefined,
      pause: () => undefined,
      resume: () => undefined,
      setSpeed: (m) => speeds.push(m),
      whenStopped: new Promise(() => undefined),
    };
    const controller = createRunController(baseDeps({ start: () => handle }));
    controller.run();
    await flush();
    speeds.length = 0; // drop the reapply from startEngine; measure the explicit call
    controller.setSpeed(2);
    expect(speeds).toEqual([2]);
  });

  it("setSpeed is a safe no-op when no engine is live", () => {
    const controller = createRunController(baseDeps({}));
    expect(() => controller.setSpeed(2)).not.toThrow();
  });

  it("rejects a speed outside 0.5|1|2 before it retains it", async () => {
    const speeds: number[] = [];
    let call = 0;
    const controller = createRunController(
      baseDeps({
        getAlgorithmSource: () => sourceMode(`source-${call}`),
        start: () => {
          call++;
          return {
            stop: () => undefined,
            pause: () => undefined,
            resume: () => undefined,
            setSpeed: (m) => speeds.push(m),
            whenStopped: new Promise(() => undefined),
          };
        },
      }),
    );
    controller.run(); // first start reapplies the default speed 1
    await flush();
    const setInvalid = (): void => {
      // @ts-expect-error 3 is not a Speed: the controller must reject it before retaining
      controller.setSpeed(3);
    };
    expect(setInvalid).toThrow(); // invalid: rejected
    controller.run(); // a replacement run reapplies the retained speed, still 1
    await flush();
    expect(speeds).toEqual([1, 1]); // the invalid 3 never retained, never reapplied
  });

  it("reapplies the retained speed on the next startEngine, so a replacement run inherits it", async () => {
    const speeds: number[] = [];
    let call = 0;
    const controller = createRunController(
      baseDeps({
        getAlgorithmSource: () => sourceMode(`source-${call}`),
        start: () => {
          call++;
          return {
            stop: () => undefined,
            pause: () => undefined,
            resume: () => undefined,
            setSpeed: (m) => speeds.push(m),
            whenStopped: new Promise(() => undefined),
          };
        },
      }),
    );
    controller.run(); // first engine: reapply default speed 1
    await flush();
    speeds.length = 0;
    controller.setSpeed(2); // retain and apply to the live engine
    speeds.length = 0;
    controller.run(); // a replacement run inherits the retained 2 on start
    await flush();
    expect(speeds).toEqual([2]);
  });

  it("stops the new handle rather than orphan it when a speed reapply throws", async () => {
    let stops = 0;
    const controller = createRunController(
      baseDeps({
        start: () => ({
          stop: () => {
            stops += 1;
          },
          pause: () => undefined,
          resume: () => undefined,
          setSpeed: () => {
            throw new Error("setSpeed boom");
          },
          whenStopped: new Promise(() => undefined),
        }),
      }),
    );
    controller.run(); // the reapply calls setSpeed, which throws
    await flush();
    expect(stops).toBe(1); // the freshly built handle was stopped, not left running
  });
});

describe("run controller loader and profiler seam derive from one AlgorithmSource (M2a)", () => {
  it("derives a url loader target and a url profiler request in url mode", async () => {
    const workers: FakeProfilerWorker[] = [];
    const loaded: LoadTarget[] = [];
    const controller = createRunController(
      workerDeps({
        getAlgorithmSource: () => urlMode("src/algorithms/kiosk.ts", 4),
        loadAlgorithm: async (target) => {
          loaded.push(target);
          return algo;
        },
        spawnProfilerWorker: () => {
          const worker = new FakeProfilerWorker();
          workers.push(worker);
          return worker;
        },
      }),
    );
    controller.run();
    await flush();
    // The loader imported the versioned URL, not a source string.
    expect(loaded).toEqual([{ kind: "url", url: "src/algorithms/kiosk.ts?v=4" }]);
    // The profiler worker was handed the same discriminated url target.
    expect(workers[0]?.posted[0]?.target).toEqual({
      kind: "url",
      url: "src/algorithms/kiosk.ts?v=4",
    });
    workers[0]?.emitMessage(OK_OUTCOME);
    await flush();
  });

  it("derives a source loader target and a source profiler request in source mode", async () => {
    const workers: FakeProfilerWorker[] = [];
    const loaded: LoadTarget[] = [];
    const controller = createRunController(
      workerDeps({
        getAlgorithmSource: () => sourceMode("export const detect = () => []"),
        loadAlgorithm: async (target) => {
          loaded.push(target);
          return algo;
        },
        spawnProfilerWorker: () => {
          const worker = new FakeProfilerWorker();
          workers.push(worker);
          return worker;
        },
      }),
    );
    controller.run();
    await flush();
    expect(loaded).toEqual([{ kind: "source", source: "export const detect = () => []" }]);
    expect(workers[0]?.posted[0]?.target).toEqual({
      kind: "source",
      source: "export const detect = () => []",
    });
    workers[0]?.emitMessage(OK_OUTCOME);
    await flush();
  });

  it("hands the main-thread fallback a url target when the worker cannot spawn", async () => {
    const targets: LoadTarget[] = [];
    const controller = createRunController(
      workerDeps({
        getAlgorithmSource: () => urlMode("src/algorithms/kiosk.ts", 2),
        spawnProfilerWorker: () => {
          throw new Error("module Worker forbidden here");
        },
        mainThreadResolveServiceRate: (target) => {
          targets.push(target);
          return { rate: Promise.resolve(FIXED_RATE), cancel: () => undefined };
        },
      }),
    );
    controller.run();
    await flush();
    expect(targets).toEqual([{ kind: "url", url: "src/algorithms/kiosk.ts?v=2" }]);
  });

  it("hands the main-thread fallback a source target when the worker cannot spawn", async () => {
    const targets: LoadTarget[] = [];
    const controller = createRunController(
      workerDeps({
        getAlgorithmSource: () => sourceMode("export const detect = () => []"),
        spawnProfilerWorker: () => {
          throw new Error("module Worker forbidden here");
        },
        mainThreadResolveServiceRate: (target) => {
          targets.push(target);
          return { rate: Promise.resolve(FIXED_RATE), cancel: () => undefined };
        },
      }),
    );
    controller.run();
    await flush();
    expect(targets).toEqual([{ kind: "source", source: "export const detect = () => []" }]);
  });
});

describe("run controller calibration cache key (M2a)", () => {
  it("keys url mode on path+version: an unchanged ref reuses the rate, a save (version bump) busts it", async () => {
    let src = urlMode("src/algorithms/kiosk.ts", 1);
    let calls = 0;
    const controller = createRunController(
      baseDeps({
        getAlgorithmSource: () => src,
        resolveServiceRate: () => {
          calls += 1;
          return fixedServiceRate();
        },
      }),
    );
    controller.run();
    await flush();
    controller.run(); // same path + version: cached, no re-profile
    await flush();
    expect(calls).toBe(1);

    src = urlMode("src/algorithms/kiosk.ts", 2); // a save bumps the version -> bust
    controller.run();
    await flush();
    expect(calls).toBe(2);

    src = urlMode("src/algorithms/kiosk.ts", 1); // back to v1: still cached, no collision
    controller.run();
    await flush();
    expect(calls).toBe(2);

    src = urlMode("src/algorithms/other.ts", 1); // a different path -> bust
    controller.run();
    await flush();
    expect(calls).toBe(3);
  });

  it("keys source mode on the full source string: unchanged reuses, changed re-profiles", async () => {
    let source = "source-A";
    let calls = 0;
    const controller = createRunController(
      baseDeps({
        getAlgorithmSource: () => sourceMode(source),
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

  it("keeps seed in the key, so a seed change never reuses a stale rate (M2a)", async () => {
    let seed = 1;
    let calls = 0;
    const controller = createRunController(
      baseDeps({
        getAlgorithmSource: () => urlMode("src/algorithms/kiosk.ts", 1), // fixed ref
        getSeed: () => seed,
        resolveServiceRate: () => {
          calls += 1;
          return fixedServiceRate();
        },
      }),
    );
    controller.run();
    await flush();
    expect(calls).toBe(1);
    seed = 2; // same ref, different seed: the rate must be re-measured
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
  posted: { target: LoadTarget; hidden: boolean }[] = [];
  terminated = false;

  postMessage(message: { target: LoadTarget; hidden: boolean }): void {
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
    getAlgorithmSource: () => sourceMode(),
    getSeed: () => 1,
    setSnapshot: () => undefined,
    setError: () => undefined,
    setRunPending: () => undefined,
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
    workers[0]?.emitMessage({ ok: false, error: "detect must return an array of findings" });
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
