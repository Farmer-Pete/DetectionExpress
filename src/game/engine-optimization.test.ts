import { describe, expect, it } from "vitest";
import { createScorer, type Scorer, type ScorerConfig } from "../sim/correctness";
import { isRawKioskV1, type RawKioskV1 } from "../sim/endpoints/kiosk/formats/kiosk-v1";
import { normalizeKiosk } from "../sim/endpoints/kiosk/normalize";
import type { PipeEvent } from "../sim/event";
import type { Finding } from "../sim/finding";
import type { GraphEdge, GraphNode } from "../sim/graph";
import { buildOptimizedRule } from "../sim/scenarios/pin-brute-force/optimization";
import { buildReferenceAlgorithm } from "../sim/scenarios/pin-brute-force/reference";
import { pinBruteForce } from "../sim/scenarios/pin-brute-force/scenario";
import type { ServiceRate } from "../sim/service-governor";
import type { SimSnapshot } from "../sim/snapshot";
import type { TaskAlgorithm } from "../sim/tasks";
import { ManualDriver } from "./clock";
import { start } from "./engine";
import {
  CORRECTNESS_FLOOR,
  CORRECTNESS_W_FN,
  CORRECTNESS_W_FP,
  CORRECTNESS_WINDOW,
  LEVEL_SEED,
} from "./tuning";

/**
 * M3: the naive default drowns while the applied Optimization wins, through the
 * real engine on a ManualDriver. The naive rule is CORRECT but priced slow, so at
 * a drowning service rate its Queue outgrows the final deadline and the run fails
 * on Queue, not on Correctness. The Optimization is the same detector at an O(1)
 * cost, so at its faster rate the run drains and wins with Correctness held. A run
 * also replays identical traces on a fixed rate (seam 14). See GH3-PLAN.md 6.5, 13,
 * and 9 (seams 13-15).
 */

const NODES: GraphNode[] = [
  { id: "ingest", kind: "ingest" },
  { id: "normalize", kind: "normalize" },
  { id: "detect", kind: "detect" },
  { id: "sink", kind: "sink" },
];
const EDGES: GraphEdge[] = [
  { id: "e1", source: "ingest", target: "normalize" },
  { id: "e2", source: "normalize", target: "detect" },
  { id: "e3", source: "detect", target: "sink" },
];

const SCORER_CONFIG: ScorerConfig = {
  window: CORRECTNESS_WINDOW,
  wFn: CORRECTNESS_W_FN,
  wFp: CORRECTNESS_W_FP,
};

/** A rate that leaves the naive rule between Wave 2 (15) and Wave 3 (60): it drowns. */
const NAIVE_RATE: ServiceRate = { num: 20, den: 1 };
/** A rate well above the peak arrival: the Optimization keeps up and wins. */
const OPTIMIZATION_RATE: ServiceRate = { num: 300, den: 1 };

/** The normalized record the twin detect reads, after Normalize runs. */
interface KioskView {
  account: string;
  terminal: string;
  outcome: "success" | "fail";
  id: number;
  ts: number;
  endpoint: string;
}

/** The in-process twin shape both the naive default and the Optimization satisfy. */
interface KioskTwin {
  normalize(raw: RawKioskV1): { account: string; terminal: string; outcome: "success" | "fail" };
  detect(view: KioskView): Finding[];
}

function isKioskView(value: unknown): value is KioskView {
  return value instanceof Object && "account" in value && "outcome" in value && "id" in value;
}

/** Adapt an in-process twin to the engine's untyped TaskAlgorithm at the boundary. */
function taskAlgorithmFor(twin: KioskTwin): TaskAlgorithm {
  return {
    normalize: (raw) => (isRawKioskV1(raw) ? twin.normalize(raw) : raw),
    detect: (view) => (isKioskView(view) ? twin.detect(view) : []),
  };
}

/**
 * The Optimization as a `KioskTwin`: the shared kiosk normalizer plus one fresh
 * `buildOptimizedRule()` instance (the EngineRule factory port, GH42-PLAN.md
 * "optimization.ts (decision: port it)"), the same way `buildReferenceAlgorithm`
 * wraps `rule.ts`'s factory.
 */
function buildOptimizedTwin(): KioskTwin {
  const rule = buildOptimizedRule();
  return {
    normalize: normalizeKiosk,
    detect: (view) => rule.detect({ ...view }),
  };
}

async function flush(rounds: number): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
}

async function step(driver: ManualDriver, ticks: number, flushRounds: number): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    driver.tick();
    await flush(flushRounds);
  }
}

interface RunOptions {
  algorithm: TaskAlgorithm;
  scorer: Scorer;
  generator: () => PipeEvent | null;
  serviceRate: ServiceRate;
  checkpoints: ReturnType<typeof pinBruteForce.generate>["checkpoints"];
  waves: ReturnType<typeof pinBruteForce.generate>["waves"];
}

interface RunResult {
  snapshots: SimSnapshot[];
  last: SimSnapshot | undefined;
}

/** Run a whole scenario to its final deadline on a ManualDriver, collecting snapshots. */
async function runToDeadline(opts: RunOptions, flushRounds: number): Promise<RunResult> {
  const driver = new ManualDriver();
  const snapshots: SimSnapshot[] = [];
  const deadline = opts.checkpoints[opts.checkpoints.length - 1]?.atTick ?? 0;
  const handle = start({
    getGraph: () => ({ nodes: NODES, edges: EDGES }),
    setSnapshot: (snapshot) => snapshots.push(snapshot),
    algorithm: opts.algorithm,
    scorer: opts.scorer,
    generator: opts.generator,
    serviceRate: opts.serviceRate,
    checkpoints: opts.checkpoints,
    waves: opts.waves,
    driver,
  });
  await step(driver, deadline + 2, flushRounds);
  await handle.whenStopped;
  return { snapshots, last: snapshots.at(-1) };
}

function scheduleOf(events: PipeEvent[]): () => PipeEvent | null {
  let i = 0;
  return () => (i < events.length ? (events[i++] ?? null) : null);
}

describe("the naive default drowns through the real engine (M3 integration)", () => {
  it("fails at the final deadline on Queue, not on Correctness", async () => {
    const run = pinBruteForce.generate(LEVEL_SEED);
    const result = await runToDeadline(
      {
        algorithm: taskAlgorithmFor(buildReferenceAlgorithm()),
        scorer: createScorer(run.attacks, SCORER_CONFIG),
        generator: scheduleOf(run.events),
        serviceRate: NAIVE_RATE,
        checkpoints: run.checkpoints,
        waves: run.waves,
      },
      300,
    );
    expect(result.last?.status).toBe("failed");
    expect(result.last?.failureReason).toBe("queue");
    // The rule is correct: the failure is throughput, so no false Alerts were raised.
    expect(result.last?.correctness.falseAlerts).toBe(0);
  });
});

describe("the applied Optimization wins through the real engine (M3 integration)", () => {
  it("wins at the final deadline with every Attack caught and Correctness held", async () => {
    const run = pinBruteForce.generate(LEVEL_SEED);
    const result = await runToDeadline(
      {
        algorithm: taskAlgorithmFor(buildOptimizedTwin()),
        scorer: createScorer(run.attacks, SCORER_CONFIG),
        generator: scheduleOf(run.events),
        serviceRate: OPTIMIZATION_RATE,
        checkpoints: run.checkpoints,
        waves: run.waves,
      },
      300,
    );
    expect(result.last?.status).toBe("won");
    expect(result.last?.failureReason).toBeNull();
    expect(result.last?.correctness.caught).toBe(run.attacks.length);
    expect(result.last?.correctness.missed).toBe(0);
    expect(result.last?.correctness.rolling).toBeGreaterThanOrEqual(CORRECTNESS_FLOOR);
    expect(result.last?.queued).toBe(0);
  });
});

describe("determinism per machine (M3 seam 14)", () => {
  it("replays identical Queue, Correctness, and status traces at a fixed rate", async () => {
    const trace = (result: RunResult) =>
      result.snapshots.map((s) => ({
        queued: s.queued,
        correctness: s.correctness,
        status: s.status,
        failureReason: s.failureReason,
        admitted: s.admitted,
        completed: s.completed,
      }));

    const build = () => {
      const run = pinBruteForce.generate(LEVEL_SEED);
      return {
        algorithm: taskAlgorithmFor(buildReferenceAlgorithm()),
        scorer: createScorer(run.attacks, SCORER_CONFIG),
        generator: scheduleOf(run.events),
        serviceRate: NAIVE_RATE,
        checkpoints: run.checkpoints,
        waves: run.waves,
      };
    };

    const first = await runToDeadline(build(), 120);
    const second = await runToDeadline(build(), 120);
    expect(trace(second)).toEqual(trace(first));
    expect(first.last?.status).toBe("failed");
  });
});
