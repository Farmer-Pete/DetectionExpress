/**
 * The run controller owns the Algorithm's edit, load, and reload lifecycle. It
 * runs one async epoch: stop and start are synchronous around a single async load
 * and an async profile. A generation token is captured before any await, and a
 * permanent disposed flag cannot be overwritten, so overlapping Run presses and an
 * unmount during a load both resolve to one live run (or none). A superseded run's
 * stale profiler worker is cancelled through the same token.
 *
 * A run is a dry-run then a commit: it reads the source, loads and adapts it, and
 * profiles the Rule before it touches the live engine. Only once load and profile
 * both succeed (and the generation still matches) does it stop the old engine and
 * start the new one. So a broken edit leaves the running engine untouched — the old
 * run stays authoritative until commit, and its completion callback keys on handle
 * identity, not the generation. While a run loads and profiles it drives `runPending`
 * through the store so the editor can show Apply as pending.
 *
 * It constructs the scorer and the Ingest generator per run from the Scenario and
 * the seed, measures the Rule's service rate through the profiler seam, and injects
 * the scorer, generator, service rate, and checkpoints into the engine. The engine
 * never builds them.
 */
import type { ScenarioBlueprint } from "../sim/compose-scenario";
import { createScorer, type ScorerConfig } from "../sim/correctness";
import { controlReference } from "../sim/entities/control";
import type { PipeEvent } from "../sim/event";
import type { GraphEdge, GraphNode } from "../sim/graph";
import { RuleError } from "../sim/rule-error";
import type { GeneratedRun, Scenario } from "../sim/scenario";
import type { ServiceRate } from "../sim/service-governor";
import { emptySnapshot, type SimSnapshot } from "../sim/snapshot";
import type { WorldEnv } from "../sim/world-reading";
import {
  type AlgorithmSource,
  type LoadedAlgorithm,
  type LoadTarget,
  loadAlgorithm as loadAlgorithmDefault,
  toLoadTarget,
} from "./algorithm";
import { buildAmbientFixtures, buildAmbientSpawners } from "./ambient-cast";
import {
  type AmbientCast,
  type EngineHandle,
  type ScenarioCast,
  type StartOptions,
  start as startDefault,
} from "./engine";
import { tabHidden } from "./profiler/guard";
import { profile, spawnProfilerWorker } from "./profiler/profile";
import { serviceRateForCode } from "./profiler/quantize";
import { adaptLoaded, type ProfileRequest } from "./profiler/worker-support";
import {
  CORPUS_VERSION,
  CORRECTNESS_W_FN,
  CORRECTNESS_W_FP,
  CORRECTNESS_WINDOW,
  DECISIONS_CAP,
  PROFILER_VERSION,
} from "./tuning";

/**
 * The slice of a profiler Worker the controller drives. A real `Worker` satisfies
 * it structurally, and a test provides a fake, so the message, error, defer, and
 * fallback branches are all exercised without a live worker.
 */
export interface ProfilerWorkerLike {
  postMessage(message: ProfileRequest): void;
  terminate(): void;
  addEventListener(type: "message", handler: (event: MessageEvent) => void): void;
  addEventListener(type: "error", handler: (event: ErrorEvent) => void): void;
}

/** A run or Rule error, as the editor shows it. */
export interface RuleErrorInfo {
  phase: string;
  message: string;
}

/** The playback speed multipliers the transport offers. */
export type Speed = 0.5 | 1 | 2;

/** True when a value is one of the three allowed speeds. */
function isSpeed(value: number): value is Speed {
  return value === 0.5 || value === 1 || value === 2;
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

/** Measure the service rate for a load target. Injected so tests never spawn a worker. */
type ResolveServiceRate = (target: LoadTarget) => ServiceRateHandle;

export interface RunController {
  /** Load the current source and (re)start the engine. Safe to call repeatedly. */
  run(): void;
  /**
   * Freeze or unfreeze the run. The controller retains the desired state, delegates
   * to the live engine handle when one exists, and reapplies it on the next start,
   * so an Apply or hot-reload inherits the current freeze. Safe with no engine live.
   */
  setFrozen(frozen: boolean): void;
  /**
   * Set the run's playback speed. The controller validates the value before it retains
   * it, delegates to the live engine handle when one exists, and reapplies it on the
   * next start, so an Apply or hot-reload inherits the current speed. Safe with no
   * engine live.
   */
  setSpeed(speed: Speed): void;
  /** Permanent teardown. A later load or completion sees this and does nothing. */
  dispose(): void;
}

export interface RunControllerDeps {
  scenario: Scenario;
  /**
   * Build the scenario's immutable blueprint for a seed (GH117-PLAN.md "Part B").
   * Injected, not read off `scenario`, so a test scenario that has none simply omits
   * it. When present, the controller builds the blueprint once: the scorer and the
   * pre-generated generator come from its precomposed run (byte for byte what
   * `scenario.generate(seed)` returns), and the SAME blueprint yields the instantiated
   * live cast plus env the engine steps for the map. Omitted, the controller falls back
   * to `generate` and runs with no cast — scoring is identical either way.
   */
  buildBlueprint?: (seed: number) => ScenarioBlueprint<{ id: number }>;
  getGraph: () => { nodes: GraphNode[]; edges: GraphEdge[] };
  /**
   * The one discriminated input (86-PLAN.md). The controller derives the loader,
   * the profiler request, and the calibration cache key from it. Source mode carries
   * the in-game editor string; url mode carries a served module URL (M2b's producer).
   */
  getAlgorithmSource: () => AlgorithmSource;
  getSeed: () => number;
  setSnapshot: (snapshot: SimSnapshot) => void;
  setError: (error: RuleErrorInfo | null) => void;
  /**
   * True while a run loads and profiles (the Apply dry-run, app mount, or a hot-reload);
   * false once it commits, fails, or is superseded. The editor reads it to disable Apply.
   */
  setRunPending: (pending: boolean) => void;
  /**
   * Bump the store's `runToken` once this run's engine actually installs (never on a
   * dry-run that only fails setup). FxLayer watches the bump to reset its own state
   * on a restart, since the scorer's seq and decision log both reset to zero on a
   * fresh engine. Argless: `generation` below is per-controller and restarts at 0 for
   * every fresh controller (a Metro-to-Pipeline remount), so writing it into the
   * store could reissue a token FxLayer already saw for a prior controller and skip
   * the reset.
   */
  bumpRunToken: () => void;
  /** Defaults to the real loader; tests inject a deterministic one. */
  loadAlgorithm?: (target: LoadTarget) => Promise<LoadedAlgorithm>;
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

/**
 * `Attack.threshold` is required (GH42-PLAN.md "Scoring for mixed hunts"): every
 * scenario's own Attacks set it (pin-brute-force's in `attackFromPlan`), so the
 * scorer always credits by each hunt's own evidence bar. No threshold lives here:
 * a config-level default tuned for one hunt would silently misscore any other
 * hunt whose Attacks forgot to set their own value.
 */
const SCORER_CONFIG: ScorerConfig = {
  window: CORRECTNESS_WINDOW,
  wFn: CORRECTNESS_W_FN,
  wFp: CORRECTNESS_W_FP,
  decisionsCap: DECISIONS_CAP,
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

/**
 * The separator between calibration-cache-key parts. U+241F (SYMBOL FOR UNIT
 * SEPARATOR) is a printable character that no scenario id, seed, version, path, or
 * player source contains, so two distinct key tuples never collide onto one rate. It
 * is ordinary text, not a NUL byte, so git keeps treating this file as text.
 */
const CACHE_KEY_SEP = "\u241F";

/**
 * The calibration cache key (GH3-PLAN.md 5.1, 86-PLAN.md "cache identity"): a valid
 * entry is never re-measured. Every fixed dimension is kept: scenario id, numeric
 * seed, and the corpus/profiler versions that bust the cache when either changes.
 * Only the source component varies by mode. In url mode it is `path + version`, so an
 * unchanged file reuses the rate and a save (a bumped version) busts it. In source
 * mode it is the FULL source string, not a hash. Every part is joined by
 * `CACHE_KEY_SEP`, which none of the parts can contain, so no two distinct tuples,
 * across scenario, seed, version, or mode, ever share a key.
 */
function calibrationCacheKey(
  scenarioId: string,
  seed: number,
  algorithmSource: AlgorithmSource,
): string {
  const prefix = [scenarioId, seed, CORPUS_VERSION, PROFILER_VERSION].join(CACHE_KEY_SEP);
  return algorithmSource.kind === "url"
    ? [prefix, "url", algorithmSource.path, algorithmSource.version].join(CACHE_KEY_SEP)
    : [prefix, "source", algorithmSource.source].join(CACHE_KEY_SEP);
}

/** Cap the memo so a long editing session cannot grow it without bound. */
const RATE_CACHE_MAX = 64;

/**
 * The fallback service-rate seam: measure on the main thread. Correct, but it
 * blocks for the profile's duration, so it is only used where a module Worker is
 * unavailable (some dev servers and embedded browsers reject one). It loads the
 * target, adapts it exactly as the worker does, profiles it, and quantizes.
 */
function mainThreadResolveServiceRate(target: LoadTarget): ServiceRateHandle {
  const rate = (async (): Promise<ServiceRate> => {
    const loaded = await loadAlgorithmDefault(target);
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
  return (target: LoadTarget): ServiceRateHandle => {
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
          fallback(target).rate.then(settleRate, settleError);
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
        worker.postMessage({ target, hidden: tabHidden() });
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

/**
 * Assemble the whole living metro the engine steps for the map (GH117-PLAN.md "Part B"):
 * the scored scenario cast plus the ambient life, over ONE shared env and seed.
 *
 * The scenario cast comes from the blueprint: `instantiate()` builds fresh actors in
 * descriptor order, each pairing by index with its descriptor's `kind`, `provenance`, and
 * `initialPresence`. The ambient cast (trains, operators, hosts, and the three spawners)
 * is built from the same world and seed. Both step over one env: the blueprint's env,
 * augmented with `control`, which the ambient operators and hosts read. Adding `control`
 * cannot move a scenario reading — the scenario actors read no env — so the precompose's
 * parity holds. `runSeed` seeds the shared schedule, matching the batch path's seeding.
 */
function buildMapCast(
  blueprint: ScenarioBlueprint<{ id: number }>,
  runSeed: number,
): { scenarioCast: ScenarioCast; ambientCast: AmbientCast } {
  const actors = blueprint.instantiate();
  const members = actors.map((actor, i) => {
    const descriptor = blueprint.descriptors[i];
    if (descriptor === undefined) {
      throw new Error(
        `run-controller: instantiate() returned ${actors.length} actors but the blueprint has ` +
          `${blueprint.descriptors.length} descriptors; they must align by index.`,
      );
    }
    return {
      actor,
      kind: descriptor.kind,
      provenance: descriptor.provenance,
      initialPresence: descriptor.initialPresence,
    };
  });
  // One env for the whole cast: the blueprint's, plus the control-room reference the
  // ambient operator and host fixtures read. Scenario actors ignore it, so parity holds.
  const env: WorldEnv = { ...blueprint.env, control: controlReference };
  const world = env.world;
  const ambientCast: AmbientCast = {
    fixtures: buildAmbientFixtures(world, env.timetable),
    ...buildAmbientSpawners(world, runSeed),
  };
  return { scenarioCast: { members, env, runSeed }, ambientCast };
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
  // The retained transport state. This is the source of truth: startEngine reapplies
  // it to every fresh clock, so an Apply or hot-reload inherits the current freeze and
  // speed. Default speed 1, so a normal startup runs at the base rate.
  let frozen = false;
  let speed: Speed = 1;

  const run = async (): Promise<void> => {
    if (disposed) {
      return;
    }
    const gen = ++generation; // captured synchronously, BEFORE any await
    deps.setRunPending(true);
    // One generation-guarded finally clears the pending flag at every exit of run()
    // (a commit, an error, a supersession, or a synchronous setup throw). A superseded
    // run leaves the guard false, so it never clears the newer run's flag, and dispose()
    // clears the flag itself since it bumps the generation past this run.
    try {
      // Guarded so a throw here (a getAlgorithmSource/getSeed bug) reports a structured
      // setup-phase error instead of rejecting the discarded run() promise silently. The
      // one discriminated input is captured here; the loader, the profiler request, and
      // the cache key are all derived from it. This is a dry-run step: it must NOT stop
      // the live engine, so a setup failure leaves the running engine owned and untouched.
      let algorithmSource: AlgorithmSource;
      let target: LoadTarget;
      let seed: number;
      try {
        profile?.cancel(); // terminate a still-running measurement from the prior run
        profile = null;
        algorithmSource = deps.getAlgorithmSource();
        target = toLoadTarget(algorithmSource); // the loader and profiler both import this
        seed = deps.getSeed();
      } catch (error) {
        deps.setError(toErrorInfo("setup", error));
        return;
      }

      let algo: LoadedAlgorithm;
      try {
        algo = await load(target);
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
      const cacheKey = calibrationCacheKey(deps.scenario.id, seed, algorithmSource);
      let serviceRate: ServiceRate;
      const cached = rateCache.get(cacheKey);
      if (cached !== undefined) {
        serviceRate = cached;
      } else {
        // Measure the service rate off the sim. A superseded run cancels its worker.
        const pending = resolveServiceRate(target);
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
        if (rateCache.size > RATE_CACHE_MAX) {
          const oldest = rateCache.keys().next().value; // Map keeps insertion order
          if (oldest !== undefined) {
            rateCache.delete(oldest);
          }
        }
      }

      // Commit. Load and profile passed and the generation still matches, so tear down
      // the old engine and start the new one. This is the only place `engine` is stopped
      // or replaced, so a failed dry-run never orphans the running engine.
      let phase = "setup";
      try {
        // Build the blueprint once when the scenario provides one (GH117 Part B). The
        // scorer and generator come from its precomposed run — byte for byte what
        // `generate(seed)` returns — and the same blueprint yields the live cast + env.
        // A scenario without a blueprint falls back to `generate` and runs with no cast.
        const blueprint = deps.buildBlueprint?.(seed) ?? null;
        const generated: GeneratedRun = blueprint
          ? {
              events: [...blueprint.precomposed.events],
              attacks: [...blueprint.precomposed.attacks],
              checkpoints: [...blueprint.checkpoints],
              waves: [...blueprint.waves],
            }
          : deps.scenario.generate(seed); // fresh per run
        const scorer = createScorer(generated.attacks, SCORER_CONFIG);
        let index = 0;
        const generator = (): PipeEvent | null =>
          index < generated.events.length ? (generated.events[index++] ?? null) : null;
        const mapCast = blueprint ? buildMapCast(blueprint, seed) : undefined;
        deps.setError(null);
        deps.setSnapshot(emptySnapshot());
        phase = "start";
        engine?.stop(); // sync + idempotent; the old run's tasks unwind on their own
        const handle = startEngine({
          getGraph: deps.getGraph,
          setSnapshot: deps.setSnapshot,
          algorithm: algo,
          scorer,
          generator,
          serviceRate,
          checkpoints: generated.checkpoints,
          waves: generated.waves,
          ...(mapCast
            ? { scenarioCast: mapCast.scenarioCast, ambientCast: mapCast.ambientCast }
            : {}),
          onError: (error) => deps.setError(toErrorInfo("run", error)),
        });
        engine = handle;
        deps.bumpRunToken(); // the engine actually installed: publish the restart
        // Reapply the retained transport state to the fresh clock. Apply and hot-reload
        // build a new clock, so without this a frozen or 2x session would drive a new
        // unpaused 1x one. The reapply is transactional: if pause or setSpeed throws, the
        // freshly built handle is stopped rather than orphaned, then the throw rethrows to
        // the outer catch, which nulls the engine and reports it as a start-phase error.
        try {
          if (frozen) {
            handle.pause();
          }
          handle.setSpeed(speed);
        } catch (reapplyError) {
          handle.stop();
          throw reapplyError;
        }
        // The live engine's completion keys on handle identity, not the generation, so an
        // old run that finishes during a later dry-run still reports its completion. A
        // superseded or replaced engine (engine !== handle) or a disposed controller is ignored.
        void handle.whenStopped.then(() => {
          if (!disposed && engine === handle) {
            deps.onFinished?.();
          }
        });
      } catch (error) {
        // Null the engine only once `phase` reaches "start", the point past `engine?.stop()`:
        // there the old engine is stopped, so dropping the reference orphans nothing, and the
        // null also suppresses the stopped handle's `onFinished`. A "setup" throw (a bad
        // `scenario.generate`/`createScorer`) happens BEFORE the stop, so the old engine is
        // still live and must keep its reference, or a later Apply or dispose() cannot stop it.
        if (phase === "start") {
          engine = null;
        }
        deps.setError(toErrorInfo(phase, error)); // "setup" vs "start"
      }
    } finally {
      if (!disposed && gen === generation) {
        deps.setRunPending(false);
      }
    }
  };

  const dispose = (): void => {
    disposed = true;
    generation++; // a load resolving later sees the moved generation and starts nothing
    profile?.cancel();
    engine?.stop();
    deps.setRunPending(false); // dispose bumped the generation, so an in-flight finally won't
  };

  // Retain the desired freeze and, when a clock is live, apply it at once. With no
  // engine live it just stores the value; startEngine reapplies it on the next start.
  const setFrozen = (next: boolean): void => {
    frozen = next;
    if (engine) {
      if (next) {
        engine.pause();
      } else {
        engine.resume();
      }
    }
  };

  // Validate before retaining, so an invalid value never reaches a later reapply. Then
  // retain and, when a clock is live, apply it at once. With no engine live it just
  // stores the value; startEngine reapplies it on the next start.
  const setSpeed = (next: Speed): void => {
    if (!isSpeed(next)) {
      throw new Error(`RunController.setSpeed needs one of 0.5, 1, 2, got ${next}.`);
    }
    speed = next;
    engine?.setSpeed(next);
  };

  return {
    run: () => {
      void run();
    },
    setFrozen,
    setSpeed,
    dispose,
  };
}
