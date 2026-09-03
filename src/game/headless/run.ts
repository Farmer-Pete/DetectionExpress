/**
 * The headless run helper (GH128-PLAN.md). One code path drives a Scenario through
 * the real webapp run path, `createRunController`
 * (`src/game/run-controller.ts`), with no browser, no DOM, and no real clock. The
 * `mode` flag flips only the schedule, the stop condition, and the verdict rule
 * (see the plan's "One helper, two modes"); the deps injection, the start gate,
 * the scorer capture, and the tick loop are all shared.
 *
 * Reuses the app's run path rather than reimplementing run, scoring, or scheduling
 * logic: it only injects headless versions of the seams the app fills with browser
 * code (a loaded Algorithm, a service rate, and the driver + scorer capture).
 */
import type { CorrectnessReading, Scorer } from "../../sim/correctness";
import { createEngine } from "../../sim/engine/engine";
import type { DetectView } from "../../sim/finding";
import type { GraphEdge, GraphNode } from "../../sim/graph";
import type { GeneratedRun, ScheduleMode } from "../../sim/scenario";
import { ManualDriver } from "../clock";
import { type EngineHandle, type StartOptions, start as startEngine } from "../engine";
import { createRunController, type RuleErrorInfo, type RunControllerDeps } from "../run-controller";
import { PIPELINE_EDGES, PIPELINE_NODES } from "../topology";
import { getScenarioEntry } from "./scenarios";
import { type HeadlessResult, type HeadlessRunOptions, verdictOf } from "./serialize";

export type { HeadlessResult, HeadlessRunOptions, RunMode } from "./serialize";

/**
 * A rate fast enough the governor never sleeps (GH128-PLAN.md "The seam injection
 * table"). The run then validates detection correctness, not throughput, matching
 * the ticket's out-of-scope note on throughput.
 */
const FAST_RATE = { num: 1_000_000, den: 1 } as const;

/**
 * Microtask-drain rounds per tick. Matches `engine.test.ts`'s own proven
 * `runReference` pattern at pin-brute-force's peak event volume, so the pipeline
 * always finishes moving a tick's Events before the next tick fires.
 */
const FLUSH_ROUNDS = 300;

/**
 * The margin past a wave run's last checkpoint tick its safety cap defaults to,
 * comfortably past the `finalTick + 2` `engine.test.ts`'s own `runReference` test
 * proves is enough to drain. Only used when `--ticks` does not override it.
 */
const WAVE_SAFETY_MARGIN_TICKS = 50;

/**
 * Normal mode's endless baseline never self-terminates, so it needs its own fixed
 * tick budget: enough ticks for a stable false-alert read. Only used when
 * `--ticks` does not override it.
 */
const DEFAULT_NORMAL_TICKS = 1000;

/**
 * How long the start gate waits for `createRunController`'s async startup epoch
 * (load, then profile) before it reports a run error (GH128-PLAN.md "The start
 * gate"). Real wall-clock: this bounds the helper's own setup, not sim time.
 */
const START_GATE_TIMEOUT_MS = 5_000;

async function flush(rounds: number): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
}

/**
 * Rebuilt from `topology.ts`, mirroring `store.ts`'s own `getGraph()` body exactly
 * (GH128-PLAN.md): `store.ts` is Vite/browser-coupled and throws under `tsx`, so it
 * cannot be imported here.
 */
function getGraph(): { nodes: GraphNode[]; edges: GraphEdge[] } {
  return {
    nodes: PIPELINE_NODES.map((node) => ({ id: node.id, kind: node.kind })),
    edges: PIPELINE_EDGES.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
    })),
  };
}

/**
 * A normalized-and-merged Detect view, by shape rather than a runtime tag (mirrors
 * `engine.test.ts`'s `isReferenceView`). Detect always receives one in a real run;
 * the guard exists only so the composed engine's `DetectView`-typed `detect` can
 * satisfy `TaskAlgorithm.detect`'s `unknown` signature soundly.
 */
function isDetectView(value: unknown): value is DetectView {
  return value instanceof Object && "id" in value && "ts" in value && "endpoint" in value;
}

/** The last checkpoint's tick, or 0 for a run with none. */
function defaultWaveTickCap(run: GeneratedRun): number {
  const last = run.checkpoints.at(-1);
  return (last?.atTick ?? 0) + WAVE_SAFETY_MARGIN_TICKS;
}

/**
 * A start-of-run failure or a Rule/task failure mid-run: a run error, never a
 * detection failure (GH128-PLAN.md "Run errors vs detection failures"). The
 * rejection this becomes is what the CLI catches, prints, and exits 2 on.
 */
class HeadlessRunError extends Error {
  constructor(info: RuleErrorInfo) {
    super(`the run failed at phase "${info.phase}": ${info.message}`);
    this.name = "HeadlessRunError";
  }
}

/**
 * Run one Scenario headlessly through the real webapp run path and report its
 * outcome. One code path for both modes (GH128-PLAN.md "One helper, two modes"):
 * `mode` only flips the schedule, the stop condition, and the verdict rule.
 *
 * Resolves with a full `HeadlessResult` whether the run is clean or not: a missed
 * Attack or a false Alert is a detection failure, reported through `verdict`, never
 * a rejection. Rejects only on a run error: a Rule or task threw, or a wave run hit
 * its safety tick cap without a natural stop (GH128-PLAN.md "Run errors vs
 * detection failures").
 */
export async function runScenarioHeadless(opts: HeadlessRunOptions): Promise<HeadlessResult> {
  const entry = getScenarioEntry(opts.scenarioId);
  const seed = opts.seed;
  const serviceRate = opts.serviceRate ?? FAST_RATE;
  const scheduleMode: ScheduleMode = opts.mode === "wave" ? "waves" : "endless";

  // The helper's own ground truth (GH128-PLAN.md "sim.json scope note"): wave mode
  // reads it straight off `generate(seed)`. Seed determinism guarantees it matches
  // the copy run-controller generates internally to build the scorer and the
  // pipeline's Ingest source. Normal mode plans no Attack at all.
  const run: GeneratedRun =
    opts.mode === "wave"
      ? entry.scenario.generate(seed)
      : { events: [], attacks: [], checkpoints: [], waves: [] };

  let recordedError: RuleErrorInfo | null = null;
  let handle: EngineHandle | null = null;
  let capturedScorer: Scorer | null = null;

  let resolveStartGate!: () => void;
  let rejectStartGate!: (error: unknown) => void;
  const startGate = new Promise<void>((resolve, reject) => {
    resolveStartGate = resolve;
    rejectStartGate = reject;
  });

  const driver = new ManualDriver();

  const deps: RunControllerDeps = {
    scenario: entry.scenario,
    scheduleMode,
    getGraph,
    getAlgorithmSource: () => "cli",
    getSeed: () => seed,
    setSnapshot: () => undefined,
    // Ignore the success-path `null`; a non-null error rejects the start gate if
    // startup has not committed yet, and is rechecked once the run ends either way
    // (GH128-PLAN.md "setError note" and "Run errors vs detection failures").
    setError: (error) => {
      if (error !== null) {
        recordedError = error;
        rejectStartGate(new HeadlessRunError(error));
      }
    },
    setRunPending: () => undefined,
    bumpRunToken: () => undefined,
    loadAlgorithm: async () => {
      const engine = createEngine({ normalizers: entry.normalizers, rules: [entry.buildRule] });
      return {
        normalize: (raw: unknown, endpoint: string): unknown => engine.normalize(raw, endpoint),
        detect: (event: unknown): unknown => (isDetectView(event) ? engine.detect(event) : []),
      };
    },
    resolveServiceRate: () => ({ rate: Promise.resolve(serviceRate), cancel: () => undefined }),
    start: (options: StartOptions): EngineHandle => {
      capturedScorer = options.scorer;
      const built = startEngine({ ...options, driver });
      handle = built;
      resolveStartGate();
      return built;
    },
  };

  const controller = createRunController(deps);
  controller.run();

  let startTimer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    startTimer = setTimeout(() => {
      reject(
        new Error(
          `runScenarioHeadless: startup did not complete within ${START_GATE_TIMEOUT_MS}ms ` +
            "(the start gate never resolved or rejected).",
        ),
      );
    }, START_GATE_TIMEOUT_MS);
  });
  try {
    await Promise.race([startGate, timeout]);
  } finally {
    // Clear the gate timer on every path, so a settled gate leaves no live timer.
    if (startTimer !== undefined) {
      clearTimeout(startTimer);
    }
  }

  if (handle === null || capturedScorer === null) {
    throw new Error("runScenarioHeadless: the engine never started.");
  }
  const liveHandle: EngineHandle = handle;
  const liveScorer: Scorer = capturedScorer;

  // Tear the run down on every exit path, so a throw never parks the engine's
  // pipeline tasks. `stop()` and `dispose()` are both safe to call after a
  // natural stop.
  try {
    if (opts.mode === "wave") {
      // Checkpoints end a wave run on their own (GH128-PLAN.md "wave mode detail"):
      // pump ticks until `whenStopped` resolves, or until the safety cap is hit,
      // which is a run error, never a stop-then-verdict.
      let stoppedNaturally = false;
      void liveHandle.whenStopped.then(() => {
        stoppedNaturally = true;
      });
      const cap = opts.ticks ?? defaultWaveTickCap(run);
      for (let i = 0; i < cap && !stoppedNaturally; i++) {
        driver.tick();
        await flush(FLUSH_ROUNDS);
      }
      if (!stoppedNaturally) {
        throw new Error(
          `runScenarioHeadless: the wave run did not stop within its safety tick cap ` +
            `(${cap} ticks); this is a run error, not a detection failure.`,
        );
      }
      await liveHandle.whenStopped;
    } else {
      // The endless baseline never self-terminates (GH128-PLAN.md "normal mode
      // detail"): pump a fixed tick budget, then stop explicitly.
      const budget = opts.ticks ?? DEFAULT_NORMAL_TICKS;
      for (let i = 0; i < budget; i++) {
        driver.tick();
        await flush(FLUSH_ROUNDS);
      }
      liveHandle.stop();
      await liveHandle.whenStopped;
      await flush(FLUSH_ROUNDS);
    }

    // Recheck after the run ends (GH128-PLAN.md "Run errors vs detection failures"):
    // a Rule or task can fail through `onError` after the start gate already resolved.
    if (recordedError !== null) {
      throw new HeadlessRunError(recordedError);
    }

    // Authoritative and sampling-independent: read the captured scorer directly,
    // never a published snapshot (GH128-PLAN.md "How the helper reads the result").
    const reading: CorrectnessReading = liveScorer.reading();

    // A queue or correctness failure also resolves `whenStopped` (engine.ts), so a
    // wave run can stop early and leave later attacks pending and uncounted; the
    // scorer would then read zero missed and zero false and look falsely `clean`.
    // Guard it: every attack must have resolved to caught or missed. If not, the
    // run did not complete and is a run error, never a verdict.
    if (opts.mode === "wave") {
      const resolved = reading.caught + reading.missed;
      if (resolved !== run.attacks.length) {
        throw new Error(
          `runScenarioHeadless: the wave run stopped before resolving every attack ` +
            `(${resolved} of ${run.attacks.length} resolved); this is a run error, ` +
            `not a detection failure.`,
        );
      }
    }

    return {
      scenarioId: opts.scenarioId,
      mode: opts.mode,
      seed,
      reading,
      decisions: liveScorer.decisions(),
      findings: liveScorer.liveFindings(),
      run,
      verdict: verdictOf(reading, opts.mode),
    };
  } finally {
    liveHandle.stop();
    controller.dispose();
  }
}
