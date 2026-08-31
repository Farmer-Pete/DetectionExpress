/**
 * SimSnapshot: the one immutable reading the sampler publishes to the store each
 * publish tick. React reads it through primitive selectors; it never sees the
 * pipeline half-updated.
 */
import type { CorrectnessReading, Decision, LiveFinding } from "./correctness";
import type { RingEvent } from "./inspector";

/** The run lifecycle, as the HUD reads it. */
export type RunStatus = "running" | "won" | "failed";

/** Why a run failed, or null while it runs or when it wins. */
export type FailureReason = "queue" | "correctness" | null;

export interface SimSnapshot {
  /** Total Queue: the sum of every channel's buffered size. */
  queued: number;
  /** Sink completions per second, smoothed. */
  throughput: number;
  /** The rolling gauge value plus the global caught / missed / false-alert counts. */
  correctness: CorrectnessReading;
  /** The current rule's cost: `1 / serviceRate`, ticks per Event. Flat per rule. */
  compute: number;
  /** The run lifecycle. */
  status: RunStatus;
  /** The typed failure reason, or null. */
  failureReason: FailureReason;
  /** Real Events admitted into the Pipeline so far. */
  admitted: number;
  /** Events completed at the Sink so far. Checkpoint queue is `admitted - completed`. */
  completed: number;
  /** Open findings, seq-ordered. The UI ranks them; T3 publishes a stable order only. */
  findings: readonly LiveFinding[];
  /**
   * The resolved decision log, seq-ordered, capped at `DECISIONS_CAP` (T10). Already
   * frozen top to bottom by the scorer; `emptySnapshot()` carries a frozen empty
   * array too, so the contract is runtime-enforced, not just a TS `readonly`.
   */
  decisions: readonly Decision[];
  /** Recent Events, id-ordered, bounded to `RING_SIZE`. */
  events: readonly RingEvent[];
  /**
   * The COUNT of Events Detect has recorded, not an id. Per-event pending state in
   * the UI is `event.id >= processed`, exact only because ids are 0-based dense and
   * Detect scores in strict FIFO id order. Queue-behind-cursor (`admitted -
   * processed`) is derived in the UI, never stored here.
   */
  processed: number;
}

/** The reading before the first sample: empty, calm, and perfectly correct. */
export function emptySnapshot(): SimSnapshot {
  return {
    queued: 0,
    throughput: 0,
    correctness: { rolling: 100, caught: 0, missed: 0, falseAlerts: 0 },
    compute: 0,
    status: "running",
    failureReason: null,
    admitted: 0,
    completed: 0,
    findings: [],
    decisions: Object.freeze([]),
    events: [],
    processed: 0,
  };
}
