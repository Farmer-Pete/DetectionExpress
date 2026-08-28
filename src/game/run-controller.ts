/**
 * The run controller owns the Algorithm's edit, load, and reload lifecycle. It
 * runs one async epoch: stop and start are synchronous around a single async load
 * and an async profile. A generation token is captured before any await, and a
 * permanent disposed flag cannot be overwritten, so overlapping Run presses and an
 * unmount during a load both resolve to one live run (or none). A superseded run's
 * stale profiler worker is cancelled through the same token.
 *
 * It constructs the scorer and the Ingest generator per run from the Scenario and
 * the seed, measures the Rule's service rate through the profiler seam, and injects
 * the scorer, generator, service rate, and checkpoints into the engine. The engine
 * never builds them.
 */
import { createScorer, type ScorerConfig } from "../sim/correctness";
import type { PipeEvent } from "../sim/event";
import type { GraphEdge, GraphNode } from "../sim/graph";
import type { Scenario } from "../sim/scenario";
import type { ServiceRate } from "../sim/service-governor";
import { emptySnapshot, type SimSnapshot } from "../sim/snapshot";
import { RuleError } from "../sim/tasks";
import { type LoadedAlgorithm, loadAlgorithm as loadAlgorithmDefault } from "./algorithm";
import { type EngineHandle, type StartOptions, start as startDefault } from "./engine";
import { tabHidden } from "./profiler/guard";
import { profile, spawnProfilerWorker } from "./profiler/profile";
import { serviceRateForCode } from "./profiler/quantize";
import { adaptLoaded } from "./profiler/worker-support";
import {
  CORPUS_VERSION,
  CORRECTNESS_W_FN,
  CORRECTNESS_W_FP,
  CORRECTNESS_WINDOW,
  PIN_BRUTE_FORCE_THRESHOLD,
  PROFILER_VERSION,
} from "./tuning";

/**
 * The slice of a profiler Worker the controller drives. A real `Worker` satisfies
 * it structurally, and a test provides a fake, so the message, error, defer, and
 * fallback branches are all exercised without a live worker.
 */
export interface ProfilerWorkerLike {
  postMessage(message: { source: string; hidden: boolean }): void;
  terminate(): void;
  addEventListener(type: "message", handler: (event: MessageEvent) => void): void;
  addEventListener(type: "error", handler: (event: ErrorEvent) => void): void;
}

/** A run or Rule error, as the editor shows it. */
export interface RuleErrorInfo {
  phase: string;
  message: string;
}

/**
 * A pending service-rate measurement. `rate` resolves with the quantized rate the
 * governor charges; `cancel` terminates the measurement (in production, a stale
 * profiler worker) when a newer run supersedes it.
 */
export interface ServiceRateHandle {
  rate: Promise<ServiceRate>;
  cancel: () => void;
}

/** Measure the service rate for a source. Injected so tests never spawn a worker. */
type ResolveServiceRate = (source: string) => ServiceRateHandle;

export interface RunController {
  /** Load the current source and (re)start the engine. Safe to call repeatedly. */
  run(): void;
  /** Permanent teardown. A later load or completion sees this and does nothing. */
  dispose(): void;
}

export interface RunControllerDeps {
  scenario: Scenario;
  getGraph: () => { nodes: GraphNode[]; edges: GraphEdge[] };
  getSource: () => string;
  getSeed: () => number;
  setSnapshot: (snapshot: SimSnapshot) => void;
  setError: (error: RuleErrorInfo | null) => void;
  /** Defaults to the real Blob loader; tests inject a deterministic one. */
  loadAlgorithm?: (source: string) => Promise<LoadedAlgorithm>;
  /**
   * The whole service-rate seam. Defaults to the worker-backed resolver built from
   * `spawnProfilerWorker` and `mainThreadResolveServiceRate` below; a test can
   * still inject a fixed rate directly, bypassing the worker seam entirely.
   */
  resolveServiceRate?: ResolveServiceRate;
  /** Defaults to the real profiler worker spawn; tests inject a fake worker. */
  spawnProfilerWorker?: () => ProfilerWorkerLike;
  /** The main-thread fallback when no module Worker can be constructed. */
  mainThreadResolveServiceRate?: ResolveServiceRate;
  /** Defaults to the real engine; tests inject a fake. */
  start?: (options: StartOptions) => EngineHandle;
  /** Called when a live run tears down on its own. */
  onFinished?: () => void;
}

const SCORER_CONFIG: ScorerConfig = {
  threshold: PIN_BRUTE_FORCE_THRESHOLD,
  window: CORRECTNESS_WINDOW,
  wFn: CORRECTNESS_W_FN,
  wFp: CORRECTNESS_W_FP,
};

function toErrorInfo(phase: string, error: unknown): RuleErrorInfo {
  if (error instanceof RuleError) {
    return { phase: error.phase, message: error.message };
  }
  if (error instanceof Error) {
    return { phase, message: error.message };
  }
  return { phase, message: String(error) };
}

/** A finite number by tag, so the worker outcome parses with no unsafe assertion. */
function isFiniteNumber(value: unknown): value is number {
  return Number.isFinite(value);
}

/**
 * Read the measured codePerAnchor out of a worker outcome, or null when the
 * message is anything else: a deferral, an `{ ok: false, error }` failure, or a
 * shape the controller does not recognize. A null therefore means "no usable
 * reading" and the caller decides whether that is a defer-and-retry or an error.
 */
function parseCodePerAnchor(data: unknown): number | null {
  if (
    data instanceof Object &&
    "ok" in data &&
    data.ok === true &&
    "result" in data &&
    data.result instanceof Object &&
    "codePerAnchor" in data.result &&
    isFiniteNumber(data.result.codePerAnchor)
  ) {
    return data.result.codePerAnchor;
  }
  return null;
}

/** True when the worker deferred because the tab is hidden (its timers are throttled). */
function deferredWhileHidden(data: unknown): boolean {
  return (
    data instanceof Object &&
    "ok" in data &&
    data.ok === false &&
    "deferred" in data &&
    data.deferred === "hidden"
  );
}

/** A small stable string hash (FNV-1a). Enough to key a calibration cache entry. */
function sourceHash(source: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < source.length; i++) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/** The calibration cache key (GH3-PLAN.md 5.1): a valid entry is never re-measured. */
function calibrationCacheKey(scenarioId: string, seed: number, source: string): string {
  return `${scenarioId}|${seed}|${sourceHash(source)}|${CORPUS_VERSION}|${PROFILER_VERSION}`;
}

/**
 * The fallback service-rate seam: measure on the main thread. Correct, but it
 * blocks for the profile's duration, so it is only used where a module Worker is
 * unavailable (some dev servers and embedded browsers reject one). It loads the
 * source, adapts it exactly as the worker does, profiles it, and quantizes.
 */
function mainThreadResolveServiceRate(source: string): ServiceRateHandle {
  const rate = (async (): Promise<ServiceRate> => {
    const loaded = await loadAlgorithmDefault(source);
    // The hidden-tab defer exists for the Worker, whose timers are clamped while
    // hidden. This synchronous main-thread measurement is not throttled by
    // visibility, so it profiles regardless (hidden: false).
    const outcome = profile(adaptLoaded(loaded), { hidden: false });
    if (!outcome.ok) {
      throw new Error(`the profiler deferred: ${outcome.deferred}`);
    }
    return serviceRateForCode(outcome.result.codePerAnchor);
  })();
  return { rate, cancel: () => {} };
}

/**
 * The production service-rate seam: spawn the profiler worker, measure the Rule off
 * the sim, and quantize `codePerAnchor * OMEGA`.
 *
 * Three worker outcomes are distinct. A usable reading resolves the rate. A hidden
 * defer is NOT a failure: the worker's timers are throttled while the tab is
 * hidden, so the measurement holds and re-runs once the tab is visible again
 * (GH3-PLAN.md 5.1/7). Anything else — an `{ ok: false, error }` failure, or a
 * shape with no reading — rejects with a clean profile error, so the Run reports it
 * instead of hanging. `cancel` terminates the worker and drops any pending
 * visibility retry, so a superseded run leaves nothing running.
 */
function makeWorkerResolveServiceRate(
  spawn: () => ProfilerWorkerLike,
  fallback: ResolveServiceRate,
): ResolveServiceRate {
  return (source: string): ServiceRateHandle => {
    let activeWorker: ProfilerWorkerLike | null = null;
    let detachVisibility: (() => void) | null = null;
    let done = false;

    const cleanup = (): void => {
      activeWorker?.terminate();
      activeWorker = null;
      detachVisibility?.();
      detachVisibility = null;
    };

    const rate = new Promise<ServiceRate>((resolve, reject) => {
      const settleError = (error: Error): void => {
        if (done) {
          return;
        }
        done = true;
        cleanup();
        reject(error);
      };
      const settleRate = (value: ServiceRate): void => {
        if (done) {
          return;
        }
        done = true;
        cleanup();
        resolve(value);
      };

      const attempt = (): void => {
        let worker: ProfilerWorkerLike;
        try {
          worker = spawn();
        } catch {
          // No module Worker here: measure on the main thread once. That path is
          // not throttled by visibility, so it profiles regardless.
          fallback(source).rate.then(settleRate, settleError);
          return;
        }
        activeWorker = worker;
        worker.addEventListener("message", (event: MessageEvent) => {
          worker.terminate();
          if (activeWorker === worker) {
            activeWorker = null;
          }
          const codePerAnchor = parseCodePerAnchor(event.data);
          if (codePerAnchor !== null) {
            settleRate(serviceRateForCode(codePerAnchor));
            return;
          }
          if (deferredWhileHidden(event.data)) {
            waitForVisible(); // hold; re-profile once the tab is visible again
            return;
          }
          settleError(new Error("the profiler returned no usable reading"));
        });
        worker.addEventListener("error", (event: ErrorEvent) => {
          worker.terminate();
          if (activeWorker === worker) {
            activeWorker = null;
          }
          settleError(
            event.error instanceof Error ? event.error : new Error("the profiler worker failed"),
          );
        });
        worker.postMessage({ source, hidden: tabHidden() });
      };

      const waitForVisible = (): void => {
        // The tab may have flipped back to visible before we handled the defer.
        if (!tabHidden()) {
          attempt();
          return;
        }
        const onVisible = (): void => {
          if (tabHidden()) {
            return; // a spurious event while still hidden
          }
          document.removeEventListener("visibilitychange", onVisible);
          detachVisibility = null;
          attempt();
        };
        detachVisibility = () => document.removeEventListener("visibilitychange", onVisible);
        document.addEventListener("visibilitychange", onVisible);
      };

      attempt();
    });

    return {
      rate,
      cancel: () => {
        if (done) {
          return;
        }
        done = true;
        cleanup();
      },
    };
  };
}

export function createRunController(deps: RunControllerDeps): RunController {
  const load = deps.loadAlgorithm ?? loadAlgorithmDefault;
  const spawn = deps.spawnProfilerWorker ?? spawnProfilerWorker;
  const fallbackResolve = deps.mainThreadResolveServiceRate ?? mainThreadResolveServiceRate;
  const resolveServiceRate =
    deps.resolveServiceRate ?? makeWorkerResolveServiceRate(spawn, fallbackResolve);
  const startEngine = deps.start ?? startDefault;

  // A resolved service rate is cached by its calibration key: an unchanged source
  // (same scenario, seed, and profiler version) reuses the rate and never spawns a
  // worker or measures again (GH3-PLAN.md 5.1).
  const rateCache = new Map<string, ServiceRate>();

  let engine: EngineHandle | null = null;
  let profile: ServiceRateHandle | null = null;
  let generation = 0;
  let disposed = false;

  const run = async (): Promise<void> => {
    if (disposed) {
      return;
    }
    const gen = ++generation; // captured synchronously, BEFORE any await

    // Guarded so a throw here (a bad stop, a getSource/getSeed bug) reports a
    // structured setup-phase error instead of rejecting the discarded run()
    // promise silently.
    let source: string;
    let seed: number;
    try {
      engine?.stop(); // sync + idempotent; the old run's tasks unwind on their own
      profile?.cancel(); // terminate a still-running measurement from the prior run
      profile = null;
      source = deps.getSource();
      seed = deps.getSeed();
    } catch (error) {
      engine = null;
      deps.setError(toErrorInfo("setup", error));
      return;
    }

    let algo: LoadedAlgorithm;
    try {
      algo = await load(source);
    } catch (error) {
      if (!disposed && gen === generation) {
        deps.setError(toErrorInfo("load", error));
      }
      return;
    }
    if (disposed || gen !== generation) {
      return; // a newer run superseded this one, or we were disposed, during the load
    }

    // Reuse a cached rate for an unchanged source: no worker, no measurement.
    const cacheKey = calibrationCacheKey(deps.scenario.id, seed, source);
    let serviceRate: ServiceRate;
    const cached = rateCache.get(cacheKey);
    if (cached !== undefined) {
      serviceRate = cached;
    } else {
      // Measure the service rate off the sim. A superseded run cancels its worker.
      const pending = resolveServiceRate(source);
      profile = pending;
      try {
        serviceRate = await pending.rate;
      } catch (error) {
        if (!disposed && gen === generation) {
          deps.setError(toErrorInfo("profile", error));
        }
        return;
      }
      if (disposed || gen !== generation) {
        pending.cancel();
        return;
      }
      profile = null; // the reading is in hand; nothing left to cancel
      rateCache.set(cacheKey, serviceRate);
    }

    let phase = "setup";
    try {
      const generated = deps.scenario.generate(seed); // fresh per run
      const scorer = createScorer(generated.attacks, SCORER_CONFIG);
      let index = 0;
      const generator = (): PipeEvent | null =>
        index < generated.events.length ? (generated.events[index++] ?? null) : null;
      deps.setError(null);
      deps.setSnapshot(emptySnapshot());
      phase = "start";
      const handle = startEngine({
        getGraph: deps.getGraph,
        setSnapshot: deps.setSnapshot,
        algorithm: algo,
        scorer,
        generator,
        serviceRate,
        checkpoints: generated.checkpoints,
        onError: (error) => deps.setError(toErrorInfo("run", error)),
      });
      engine = handle;
      // A stale or disposed completion is ignored; a superseded run's whenStopped
      // sees the moved generation or a different handle and does nothing.
      void handle.whenStopped.then(() => {
        if (!disposed && gen === generation && engine === handle) {
          deps.onFinished?.();
        }
      });
    } catch (error) {
      engine = null;
      deps.setError(toErrorInfo(phase, error)); // "setup" vs "start"
    }
  };

  const dispose = (): void => {
    disposed = true;
    generation++; // a load resolving later sees the moved generation and starts nothing
    profile?.cancel();
    engine?.stop();
  };

  return {
    run: () => {
      void run();
    },
    dispose,
  };
}
