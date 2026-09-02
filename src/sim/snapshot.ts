/**
 * SimSnapshot: the one immutable reading the sampler publishes to the store each
 * publish tick. React reads it through primitive selectors; it never sees the
 * pipeline half-updated.
 */
import type { CorrectnessReading, Decision, LiveFinding } from "./correctness";
import type { RingEvent } from "./inspector";
import type { ScheduleMode } from "./scenario";
import type { WaveReading } from "./wave-state";
import type { WorldLogEvent } from "./world-log";
// `ActorView`, `FlashEvent`, `DoorView`, and `CrowdView` stay defined in
// `world-snapshot.ts` for now (GH117 Part E, to minimize churn); import them from
// there directly.
import type { ActorView, CrowdView, DoorView, FlashEvent } from "./world-snapshot";

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
  /**
   * The wave reading at this publish tick (`waveStateAt`, `wave-state.ts`). The UI
   * never derives sim truth: this is the same reading the sampler computed off the
   * run's waves, not a value the UI infers on its own (GH38+40-PLAN.md decision 2).
   */
  wave: WaveReading;
  /**
   * The run's arrival shape (GH124-PLAN.md Checkpoint 3): `"waves"` is the
   * original climbing ramp, `"steady"` is the gapless constant stream the app
   * defaults to. The status pill reads this to show "Steady" instead of
   * "Running" while a steady run is live.
   */
  scheduleMode: ScheduleMode;
  /**
   * Live actors the embedded map draws, with semantic presence (GH117 Part E). Empty
   * until the engine steps the cast onto this snapshot; the current producer still
   * publishes `[]`.
   */
  actors: readonly ActorView[];
  /** Short, fading sensor-fire marks the map draws. Empty until the engine wires it. */
  flashes: readonly FlashEvent[];
  /** Door projection (reducer output). Empty until the engine wires it. */
  doors: readonly DoorView[];
  /** Camera reducer output: per-node crowd counts. Empty until the engine wires it. */
  crowds: readonly CrowdView[];
  /**
   * The authoritative integer game tick for the map, distinct from any UI-only
   * fractional render estimate (which stays inside `ActorLayer.tsx`). 0 until the
   * engine wires it.
   */
  nowTick: number;
  /**
   * The bounded world-event ring (GH124-PLAN.md Checkpoint 5): every sensor's raw
   * reading, oldest first, capped at `WORLD_LOG_RING_SIZE`. A separate structure
   * from `events` (the scored inspector ring): this covers every sensor kind, not
   * just the scored kiosk stream, and keys on its own id namespace
   * (`WorldLogEvent.id`), never a scored pipeline event id. The unified log panel
   * and every place dialog's scoped log both read this one ring.
   */
  worldEvents: readonly WorldLogEvent[];
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
    wave: { phase: "calm", index: null, ticksUntilNext: null, eventsPerTick: null },
    scheduleMode: "waves",
    actors: Object.freeze([]),
    flashes: Object.freeze([]),
    doors: Object.freeze([]),
    crowds: Object.freeze([]),
    nowTick: 0,
    worldEvents: Object.freeze([]),
  };
}
