/**
 * Pure serializers for the headless CLI's three output files, plus the verdict
 * rule both run modes share (GH128-PLAN.md). No I/O and no engine: every function
 * here takes plain data and returns plain data, so `run.ts` and `scripts/sim-run.ts`
 * both build on the exact same behavior with no duplication.
 */
import type { Attack } from "../../sim/attack";
import type { CorrectnessReading, Counts, Decision, LiveFinding } from "../../sim/correctness";
import type { PipeEvent } from "../../sim/event";
import type { GeneratedRun } from "../../sim/scenario";
import type { ServiceRate } from "../../sim/service-governor";

/** Whether a run replays the scripted wave schedule or the endless calm baseline. */
export type RunMode = "normal" | "wave";

/** The pass/fail verdict a completed run reads off its final counts. */
export type Verdict = "clean" | "missed" | "false-alerts";

/** One headless run's inputs (GH128-PLAN.md "Types"). */
export interface HeadlessRunOptions {
  scenarioId: string;
  mode: RunMode;
  seed: number;
  /** Defaults to a rate fast enough the governor never sleeps. */
  serviceRate?: ServiceRate;
  /** Normal mode's tick budget; wave mode's safety cap. Both fall back to a built-in default. */
  ticks?: number;
}

/** One headless run's outcome: the scorer's final state, the ground truth, and the verdict. */
export interface HeadlessResult {
  scenarioId: string;
  mode: RunMode;
  seed: number;
  /** From `scorer.reading()`: the counts and rolling score. */
  reading: CorrectnessReading;
  /** From `scorer.decisions()`: the resolved log. */
  decisions: readonly Decision[];
  /** From `scorer.liveFindings()`: the open alerts. */
  findings: readonly LiveFinding[];
  /** Wave mode: the helper's own `generate(seed)` copy. Normal mode: no attacks, no events. */
  run: GeneratedRun;
  verdict: Verdict;
}

/**
 * The truth table (GH128-PLAN.md "Verdict"): wave mode needs zero missed Attacks
 * AND zero false Alerts; normal mode, which plans no Attack at all, needs only zero
 * false Alerts.
 */
export function verdictOf(counts: Counts, mode: RunMode): Verdict {
  if (mode === "wave" && counts.missed > 0) {
    return "missed";
  }
  if (counts.falseAlerts > 0) {
    return "false-alerts";
  }
  return "clean";
}

/** One ground-truth Event, labeled benign or with the id of the Attack it is evidence for. */
interface LabeledEvent extends PipeEvent {
  label: "benign" | number;
}

/** Map each event id to the Attack id it is evidence for, then label every event. */
function labelEvents(run: GeneratedRun): LabeledEvent[] {
  const attackByEventId = new Map<number, number>();
  for (const attack of run.attacks) {
    for (const eventId of attack.eventIds) {
      attackByEventId.set(eventId, attack.id);
    }
  }
  return run.events.map((event) => ({
    ...event,
    label: attackByEventId.get(event.id) ?? "benign",
  }));
}

/** `sim.json`'s shape: the run's identity, the ground-truth Attacks, and every labeled Event. */
export interface SimJson {
  scenarioId: string;
  mode: RunMode;
  seed: number;
  attacks: readonly Attack[];
  events: readonly LabeledEvent[];
}

/**
 * `sim.json` (GH128-PLAN.md "Output files"): the seed and mode, the ground-truth
 * Attacks, and the Events, each labeled benign or its Attack id. Complete in wave
 * mode; `attacks: []` and `events: []` in normal mode, where the helper's `run`
 * already carries nothing to label (see the plan's "sim.json scope note"). Labeling
 * cannot throw on a well-formed `HeadlessResult`, but a broken read still falls back
 * to the raw, unlabeled events plus the Attacks list, which alone still carries the
 * full ground truth.
 */
export function toSimJson(result: HeadlessResult): SimJson {
  let events: readonly LabeledEvent[];
  try {
    events = labelEvents(result.run);
  } catch {
    events = result.run.events.map((event) => ({ ...event, label: "benign" as const }));
  }
  return {
    scenarioId: result.scenarioId,
    mode: result.mode,
    seed: result.seed,
    attacks: result.run.attacks,
    events,
  };
}

/** `findings.json`'s shape: two distinct arrays, never merged (see the field docs). */
export interface FindingsJson {
  /** Open alerts (`hit`/`watch`), from `scorer.liveFindings()`. */
  alerts: readonly LiveFinding[];
  /** The resolved log (`caught`/`missed`/`false`), from `scorer.decisions()`. */
  decisions: readonly Decision[];
}

/** `findings.json`: the live alerts and the resolved decisions, kept as two arrays. */
export function toFindingsJson(result: HeadlessResult): FindingsJson {
  return { alerts: result.findings, decisions: result.decisions };
}

/** `summary.json`'s shape: the run's identity, its counts and rolling score, and its verdict. */
export interface SummaryJson extends CorrectnessReading {
  scenarioId: string;
  mode: RunMode;
  seed: number;
  verdict: Verdict;
}

/** `summary.json`: the counts, the rolling score, the run's identity, and the verdict. */
export function toSummaryJson(result: HeadlessResult): SummaryJson {
  return {
    scenarioId: result.scenarioId,
    mode: result.mode,
    seed: result.seed,
    ...result.reading,
    verdict: result.verdict,
  };
}
