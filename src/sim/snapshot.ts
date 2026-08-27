/**
 * SimSnapshot: the one immutable reading the sampler publishes to the store each
 * publish tick. React reads it through primitive selectors; it never sees the
 * pipeline half-updated.
 */
import type { CorrectnessReading } from "./correctness";

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

export interface SimSnapshot {
  /** Total Backlog: the sum of every channel's buffered size. */
  backlog: number;
  /** Sink completions per second, smoothed. */
  throughput: number;
  nodes: Record<string, NodeReading>;
  edges: Record<string, EdgeReading>;
  /** The rolling gauge value plus the global caught / missed / false-alert counts. */
  correctness: CorrectnessReading;
}

/** The reading before the first sample: empty, calm, and perfectly correct. */
export function emptySnapshot(): SimSnapshot {
  return {
    backlog: 0,
    throughput: 0,
    nodes: {},
    edges: {},
    correctness: { rolling: 100, caught: 0, missed: 0, falseAlerts: 0 },
  };
}
