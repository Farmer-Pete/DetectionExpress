import { describe, expect, it } from "vitest";
import { ManualDriver } from "../../../game/clock";
import { start } from "../../../game/engine";
import { simulate } from "../../../game/profiler/band";
import {
  REFERENCE_FAST_RATE,
  REFERENCE_SLOW_RATE,
} from "../../../game/profiler/kiosk-band-calibration";
import { CHANNEL_CAP, LEVEL_SEED } from "../../../game/tuning";
import { createScorer, type ScorerConfig } from "../../correctness";
import type { PipeEvent } from "../../event";
import type { GraphEdge, GraphNode } from "../../graph";
import type { GeneratedRun } from "../../scenario";
import { buildSchedule } from "../../schedule";
import type { ServiceRate } from "../../service-governor";
import type { SimSnapshot } from "../../snapshot";
import type { TaskAlgorithm } from "../../tasks";
import { buildFareGateRun } from "./run";
import { raw, tickOf } from "./test-helpers";

/**
 * The fare-gate-rush throughput regression (issue #89). With
 * `attacks: []` and a no-alert Rule, Correctness stays vacuous (100), so this
 * isolates throughput. It checks three things: fidelity (the generated tap-ins
 * per tick match `WAVE_RATES`, and the intro and drain gaps carry none), the win
 * invariant (a no-alert run through the real engine at `REFERENCE_FAST_RATE`
 * wins cleanly, pinning the final-deadline contract against engine drift), and
 * the squeeze (the real total event curve, tap-ins and tap-outs together, still
 * separates the two reference rates through the generic band `simulate`).
 */

// --- Fidelity ----------------------------------------------------------------

function tapInCountsByTick(run: GeneratedRun): Map<number, number> {
  const counts = new Map<number, number>();
  for (const ev of run.events) {
    if (raw(ev).DIRECTION !== "ENTRY") {
      continue;
    }
    const tick = tickOf(ev);
    counts.set(tick, (counts.get(tick) ?? 0) + 1);
  }
  return counts;
}

describe("fare-gate-rush throughput: fidelity", () => {
  const run = buildFareGateRun(LEVEL_SEED);
  const { waves } = buildSchedule();
  const counts = tapInCountsByTick(run);

  it("admits exactly WAVE_RATES tap-ins per tick, inside each wave", () => {
    // The exact per-tick equality holds because WAVE_RATES are whole numbers. For a
    // fractional rate the count would be floor or ceil of the rate; that contract is
    // covered by the accumulator parity tests in admission.test.ts.
    for (const wave of waves) {
      for (let tick = wave.startTick; tick < wave.startTick + wave.durationTicks; tick++) {
        expect(counts.get(tick) ?? 0).toBe(wave.eventsPerTick);
      }
    }
  });

  it("admits zero tap-ins in the intro and every drain gap", () => {
    const lastWave = waves[waves.length - 1];
    const lastTick = lastWave === undefined ? 0 : lastWave.startTick + lastWave.durationTicks;
    const inAnyWave = (tick: number): boolean =>
      waves.some((wave) => tick >= wave.startTick && tick < wave.startTick + wave.durationTicks);
    for (let tick = 0; tick < lastTick; tick++) {
      if (!inAnyWave(tick)) {
        expect(counts.get(tick) ?? 0).toBe(0);
      }
    }
  });
});

// --- Win invariant -------------------------------------------------------------

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

/** Correctness is vacuous with attacks: [] and no alerts, so any config works. */
const SCORER_CONFIG: ScorerConfig = { threshold: 1, window: 1, wFn: 1, wFp: 1 };

/** The no-alert fixture: identity normalize, detect always returns no Findings. */
const noAlertAlgorithm: TaskAlgorithm = {
  normalize: (raw) => raw,
  detect: () => [],
};

async function runRealEngine(
  run: GeneratedRun,
  rate: ServiceRate,
): Promise<SimSnapshot | undefined> {
  const driver = new ManualDriver();
  const snapshots: SimSnapshot[] = [];
  let index = 0;
  const generator = (): PipeEvent | null =>
    index < run.events.length ? (run.events[index++] ?? null) : null;
  const handle = start({
    getGraph: () => ({ nodes: NODES, edges: EDGES }),
    setSnapshot: (snapshot) => snapshots.push(snapshot),
    algorithm: noAlertAlgorithm,
    scorer: createScorer(run.attacks, SCORER_CONFIG),
    generator,
    serviceRate: rate,
    checkpoints: run.checkpoints,
    driver,
    bindVisibility: () => () => undefined,
  });
  const deadline = run.checkpoints[run.checkpoints.length - 1]?.atTick ?? 0;
  for (let i = 0; i < deadline + 2; i++) {
    driver.tick();
    for (let r = 0; r < 300; r++) {
      await Promise.resolve();
    }
  }
  await handle.whenStopped;
  return snapshots.at(-1);
}

describe("fare-gate-rush throughput: win invariant", () => {
  it("wins with zero false alerts and admitted === completed === events.length, at the fast reference rate", async () => {
    const run = buildFareGateRun(LEVEL_SEED);
    const last = await runRealEngine(run, REFERENCE_FAST_RATE);
    expect(last?.status).toBe("won");
    expect(last?.failureReason).toBeNull();
    expect(last?.correctness.falseAlerts).toBe(0);
    expect(last?.admitted).toBe(run.events.length);
    expect(last?.completed).toBe(run.events.length);
  }, 20000);
});

// --- Squeeze on the real event curve ------------------------------------------

/** Every event per tick, tap-ins and tap-outs together: the real total volume. */
function totalArrivalsByTick(run: GeneratedRun): number[] {
  const deadline = run.checkpoints[run.checkpoints.length - 1]?.atTick ?? 0;
  const arrivals = new Array<number>(deadline + 1).fill(0);
  for (const ev of run.events) {
    const tick = tickOf(ev);
    if (tick >= 0 && tick <= deadline) {
      arrivals[tick] = (arrivals[tick] ?? 0) + 1;
    }
  }
  return arrivals;
}

describe("fare-gate-rush throughput: squeeze on the real event curve", () => {
  const run = buildFareGateRun(LEVEL_SEED);
  const arrivalsByTick = totalArrivalsByTick(run);

  it("fails a checkpoint with a Backlog margin at the slow reference rate", () => {
    const result = simulate({
      arrivalsByTick,
      serviceRate: REFERENCE_SLOW_RATE,
      channelCap: CHANNEL_CAP,
      checkpoints: run.checkpoints,
    });
    expect(result.outcome).toBe("failed");
    expect(result.backlogAtFailure).toBeGreaterThan(0);
  });

  it("clears every checkpoint with Backlog headroom at the fast reference rate", () => {
    const result = simulate({
      arrivalsByTick,
      serviceRate: REFERENCE_FAST_RATE,
      channelCap: CHANNEL_CAP,
      checkpoints: run.checkpoints,
    });
    expect(result.outcome).toBe("won");
    expect(result.failedCheckpoint).toBe(-1);
    // The real total curve (tap-ins plus their echoing tap-outs) peaks well above
    // a kiosk-only wave: two overlapping waves of the same actor can both land in
    // one tick, so Backlog transiently crosses CHANNEL_CAP (measured peak ~105)
    // without failing any checkpoint. The bound sits at 1.5 * CHANNEL_CAP: loose
    // enough for that real transient, tight enough to catch a regression drifting
    // toward the 2 * CHANNEL_CAP clamp ceiling. The win invariant is proven
    // separately through the real engine.
    expect(result.maxBacklog).toBeLessThan(1.5 * CHANNEL_CAP);
  });
});
