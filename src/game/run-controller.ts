/**
 * The run controller owns the Algorithm's edit, load, and reload lifecycle. It
 * runs one async epoch: stop and start are synchronous around a single async load.
 * A generation token is captured before any await, and a permanent disposed flag
 * cannot be overwritten, so overlapping Run presses and an unmount during a load
 * both resolve to one live run (or none).
 *
 * It constructs the scorer and the Ingest generator per run from the Scenario and
 * the seed, and injects them into the engine. The engine never builds them.
 */
import { createScorer, type ScorerConfig } from "../sim/correctness";
import type { PipeEvent } from "../sim/event";
import type { GraphEdge, GraphNode } from "../sim/graph";
import type { Scenario } from "../sim/scenario";
import { emptySnapshot, type SimSnapshot } from "../sim/snapshot";
import { RuleError } from "../sim/tasks";
import { type LoadedAlgorithm, loadAlgorithm as loadAlgorithmDefault } from "./algorithm";
import { type EngineHandle, type StartOptions, start as startDefault } from "./engine";
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

export function createRunController(deps: RunControllerDeps): RunController {
  const load = deps.loadAlgorithm ?? loadAlgorithmDefault;
  const startEngine = deps.start ?? startDefault;

  let engine: EngineHandle | null = null;
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
    engine?.stop();
  };

  return {
    run: () => {
      void run();
    },
    dispose,
  };
}
