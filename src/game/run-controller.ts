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
  CORRECTNESS_W_FN,
  CORRECTNESS_W_FP,
  CORRECTNESS_WINDOW,
  PIN_BRUTE_FORCE_THRESHOLD,
} from "./tuning";

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
  /** Defaults to the real profiler worker; tests inject a fixed rate. */
  resolveServiceRate?: ResolveServiceRate;
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

/** Read the measured codePerAnchor out of a worker outcome, or null if it deferred. */
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
 * the sim, and quantize `codePerAnchor * OMEGA`. `cancel` terminates the worker, so
 * a superseded run leaves none running. If a module Worker cannot be constructed
 * (an environment that forbids one), fall back to a main-thread measurement instead
 * of failing the run.
 */
function workerResolveServiceRate(source: string): ServiceRateHandle {
  let worker: Worker;
  try {
    worker = spawnProfilerWorker();
  } catch {
    return mainThreadResolveServiceRate(source);
  }
  const rate = new Promise<ServiceRate>((resolve, reject) => {
    worker.addEventListener("message", (event: MessageEvent) => {
      worker.terminate();
      const codePerAnchor = parseCodePerAnchor(event.data);
      if (codePerAnchor === null) {
        reject(new Error("the profiler returned no usable reading"));
        return;
      }
      resolve(serviceRateForCode(codePerAnchor));
    });
    worker.addEventListener("error", (event: ErrorEvent) => {
      worker.terminate();
      reject(event.error ?? new Error("the profiler worker failed"));
    });
    worker.postMessage({ source, hidden: tabHidden() });
  });
  return { rate, cancel: () => worker.terminate() };
}

export function createRunController(deps: RunControllerDeps): RunController {
  const load = deps.loadAlgorithm ?? loadAlgorithmDefault;
  const resolveServiceRate = deps.resolveServiceRate ?? workerResolveServiceRate;
  const startEngine = deps.start ?? startDefault;

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

    // Measure the service rate off the sim. A superseded run cancels its worker.
    const pending = resolveServiceRate(source);
    profile = pending;
    let serviceRate: ServiceRate;
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
