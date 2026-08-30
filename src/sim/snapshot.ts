/**
 * SimSnapshot: the one immutable reading the sampler publishes to the store each
 * publish tick. React reads it through primitive selectors; it never sees the
 * pipeline half-updated.
 */
import type { CorrectnessReading, LiveFinding } from "./correctness";
import type { RingEvent } from "./inspector";

/** Per-node live reading. */
interface NodeReading {
  /** 0..1, ramps while the node's input backs up. */
  heat: number;
}

/** Per-edge live reading. */
interface EdgeReading {
  /** Admitted rate: Events accepted into the edge per second. */
  inRate: number;
  /** Events pulled out per second. Drives the belt scroll speed. */
  outRate: number;
}

/** The run lifecycle, as the HUD reads it. */
export type RunStatus = "running" | "won" | "failed";

/** Why a run failed, or null while it runs or when it wins. */
export type FailureReason = "backlog" | "correctness" | null;

export interface SimSnapshot {
  /** Total Backlog: the sum of every channel's buffered size. */
  backlog: number;
  /** Sink completions per second, smoothed. */
  throughput: number;
  nodes: Record<string, NodeReading>;
  edges: Record<string, EdgeReading>;
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
  /** Events completed at the Sink so far. Checkpoint backlog is `admitted - completed`. */
  completed: number;
  /** Open findings, seq-ordered. The UI ranks them; T3 publishes a stable order only. */
  findings: readonly LiveFinding[];
  /** Recent Events, id-ordered, bounded to `RING_SIZE`. */
  events: readonly RingEvent[];
  /**
   * The COUNT of Events Detect has recorded, not an id. Per-event pending state in
   * the UI is `event.id >= processed`, exact only because ids are 0-based dense and
   * Detect scores in strict FIFO id order. Backlog-behind-cursor (`admitted -
   * processed`) is derived in the UI, never stored here.
   */
  processed: number;
}

/** The reading before the first sample: empty, calm, and perfectly correct. */
export function emptySnapshot(): SimSnapshot {
  return {
    backlog: 0,
    throughput: 0,
    nodes: {},
    edges: {},
    correctness: { rolling: 100, caught: 0, missed: 0, falseAlerts: 0 },
    compute: 0,
    status: "running",
    failureReason: null,
    admitted: 0,
    completed: 0,
    findings: [],
    events: [],
    processed: 0,
  };
}
