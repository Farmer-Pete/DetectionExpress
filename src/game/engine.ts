/**
 * The engine wires the graph into a running pipeline: a Clock, one channel per
 * edge, a node task per node, a governed Detect, and a sampler that publishes one
 * atomic snapshot at PUBLISH_HZ. It owns a deadline-driven lifecycle: a
 * transactional `start`, checkpoints evaluated at the start-of-tick boundary, a
 * single-stop supervisor, a synchronous idempotent `stop`, and a terminal deferred
 * resolved only at true teardown.
 *
 * The run no longer ends when the stream drains. It ends at a checkpoint: a failed
 * one (Queue not clear, or Correctness below the floor) or the final deadline (a
 * win when clear). Every game-outcome terminal transition force-publishes the
 * terminal snapshot first, so the HUD always receives the outcome. An explicit
 * stop is a teardown, not an outcome, so it publishes nothing.
 *
 * The Scenario, the loaded Algorithm, the scorer, the Ingest generator, the service
 * rate, and the checkpoints are all injected by the run controller, so `sim/` stays
 * pure and the engine never builds them or reads a sensor field itself.
 */
import { randomLcg } from "d3-random";
import type { AccountRiderSpawner } from "../sim/actors/account-rider-spawner";
import {
  type Actor,
  type ActorProvenance,
  type Admission,
  createSchedule,
  type StepResult,
  type TimedReading,
} from "../sim/actors/actor";
import type { RiderSpawner } from "../sim/actors/rider-spawner";
import type { StaffSpawner } from "../sim/actors/staff-spawner";
import { Channel } from "../sim/channel";
import type { Scorer } from "../sim/correctness";
import type { PipeEvent, PipeMessage } from "../sim/event";
import { type GraphEdge, type GraphNode, validateLinearChain } from "../sim/graph";
import { createInspector, type Inspector } from "../sim/inspector";
import { makeWindowedRate } from "../sim/rate";
import type { Checkpoint, ScheduleMode, Wave } from "../sim/scenario";
import { PIN_BRUTE_FORCE_REASON } from "../sim/scenarios/pin-brute-force/attacks";
import { planChaosWave } from "../sim/scenarios/pin-brute-force/chaos-wave";
import type { ScoredIngress } from "../sim/scored-ingress";
import type { ServiceRate } from "../sim/service-governor";
import type { FailureReason, RunStatus, SimSnapshot } from "../sim/snapshot";
import { NODE_TASKS, type NodeRuntime, type NodeWiring, type TaskAlgorithm } from "../sim/tasks";
import { assertWaveScheduleOrdered } from "../sim/wave-schedule";
import { waveSeed } from "../sim/wave-seed";
import { type WaveReading, waveStateAt } from "../sim/wave-state";
import {
  cameraNodeId,
  consoleNodeId,
  contactNodeId,
  gateIdForStation,
  gateNodeId,
  kioskNodeId,
  readerNodeId,
  relayNodeId,
  tvmNodeId,
} from "../sim/world/layout";
import type { MapNodeId, Presence } from "../sim/world/presence";
import { createWorldLog, type WorldLog, type WorldLogEvent } from "../sim/world-log";
import type { WorldEnv, WorldReading } from "../sim/world-reading";
import type { ActorView, CrowdView, DoorView, FlashEvent } from "../sim/world-snapshot";
import { type CameraGrant, createCameraReducer } from "./camera-reducer";
import { Clock, ClockStoppedError, intervalDriver, type TickDriver } from "./clock";
import { createDoorReducer } from "./door-reducer";
import {
  CAMERA_WINDOW_TICKS,
  CHANNEL_CAP,
  CLOCK_HZ,
  CORRECTNESS_FLOOR,
  DOOR_DWELL_TICKS,
  FLASH_WINDOW_TICKS,
  GAME_SECONDS_PER_TICK,
  PUBLISH_HZ,
  QUEUE_CAP,
  RING_SIZE,
  THROUGHPUT_WINDOW_MS,
  WAVE_DRAIN_MARGIN_TICKS,
  WAVE_TRIGGER_MARGIN_TICKS,
  WAVE_WARN_TICKS,
  WORLD_LOG_RING_SIZE,
} from "./tuning";

/**
 * One member of the instantiated scenario cast the engine steps for the map
 * (GH117-PLAN.md "Part B"). It pairs a fresh actor (from `blueprint.instantiate()`)
 * with the three things the blueprint descriptor carries that the engine needs at
 * runtime: the view `kind` it draws as, its `provenance` (all `scored-scenario`
 * today; the admission filter reads it in a later step), and the `initialPresence`
 * to seed its `ActorView` with before its first `act()`. Mirrors `WorldFixture`.
 */
/**
 * A triggered chaos wave's id (GH126-PLAN.md M2b, finding 5). Minted from a
 * monotonic counter on the engine handle, never reused, distinct in role from the
 * dense scored event id and from the scorer's `attackId`.
 */
export type WaveId = number;

/** Whether a resolved wave was held or breached. */
type WaveOutcomeKind = "held" | "breach";

/**
 * A resolved chaos wave, reported once at its drain watermark. For M2b this is the
 * minimal exposure: the engine logs it to the console and hands it to a TEST-ONLY
 * `onWaveOutcome` observer. The store `ChaosPhase`/`WaveOutcome` fields and the
 * on-screen banner are M3.
 */
export interface WaveOutcomeObservation {
  waveId: WaveId;
  outcome: WaveOutcomeKind;
  /** How many attacks this wave launched (its 2 to 8 attackers). */
  attackCount: number;
  /** How many of those attacks resolved caught (vs missed at the drain watermark). */
  caughtCount: number;
  /** Whether EVERY attack resolved caught: `caughtCount === attackCount`. */
  allCaught: boolean;
  /**
   * The wave-window peak of the in-flight backlog: the `ScoredIngress` buffer plus
   * every channel's contents (finding 8). "held" needs both `allCaught` and this at
   * or under `QUEUE_CAP`.
   */
  queuePeak: number;
}

/**
 * The live state of the one active chaos wave (GH126-PLAN.md M2b, Q7: one wave at a
 * time). Non-null between `triggerWave` and the drain watermark; its non-null-ness IS
 * the cooldown that makes a second trigger a no-op.
 */
interface ActiveWaveAttack {
  /** This attack's scorer key, minted from the global monotonic counter. */
  attackId: number;
  /** `wave-<WaveId>-attacker-<i>`: the admitted attacker whose fails are this attack's evidence. */
  actorId: string;
  /** How many fails this attacker emits; every one is bound as evidence (`evidenceCount`). */
  expectedEvidence: number;
  /** The bound global scored ids for this attacker, in offer order; the last is its highest. */
  collectedEvidence: number[];
}

interface ActiveWave {
  waveId: WaveId;
  /** The wave's 2 to 8 attacks, each on its own victim and actor (`planChaosWave`). */
  attacks: ActiveWaveAttack[];
  /** The shared detection-window close, in game seconds (all attacks share one window). */
  windowEnd: number;
  /** `windowEnd` plus the drain margin: the earliest game-seconds the wave may resolve. */
  drainDeadline: number;
  /** The running peak of the in-flight backlog over the wave window. */
  queuePeak: number;
}

export interface ScenarioCastMember {
  actor: Actor<WorldReading, WorldEnv>;
  kind: ActorView["kind"];
  provenance: ActorProvenance;
  initialPresence: (firstTick: number) => Presence;
}

/**
 * The scenario cast plus the two run inputs a schedule needs to step it: the shared
 * read-only `env` and the `runSeed` that seeds each actor. Passed as one all-or-nothing
 * object so the existing scored-engine tests, which inject none, run byte-identically:
 * no schedule, no stepping listener, `nowTick` stays 0 and the map fields stay empty.
 */
export interface ScenarioCast {
  readonly members: readonly ScenarioCastMember[];
  readonly env: WorldEnv;
  readonly runSeed: number;
}

/**
 * One ambient startup fixture the merged engine steps for the map (GH117-PLAN.md
 * "Part B"): a train, an operator, or a host. It pairs a fresh actor with the view
 * `kind` it draws as and the `initialPresence` to seed its `ActorView`. Provenance is
 * always `"ambient"`, so it is not carried here. Structurally identical to the legacy
 * `WorldFixture`, so `world-run-controller`'s builders satisfy it unchanged.
 */
export interface AmbientFixture {
  actor: Actor<WorldReading, WorldEnv>;
  kind: ActorView["kind"];
  initialPresence: (firstTick: number) => Presence;
}

/**
 * The metro's ambient life the merged engine folds onto the same Clock and schedule as
 * the scenario cast (GH117-PLAN.md "Part B", decision 3). `fixtures` are the persistent
 * startup actors (trains, operators, hosts); the three optional spawners are the seeded
 * runtime sources the engine admits each tick, every admission tagged `"ambient"`
 * provenance. Attached alongside `scenarioCast`, it shares that cast's `env` and
 * `runSeed`: one schedule, one env, one seed. Ambient fixture ids seed in the ambient
 * domain (`createSchedule`'s `ambientIds`), so a scenario actor's seed never moves.
 * Omitted, the engine steps the scenario cast alone, exactly as before.
 */
export interface AmbientCast {
  readonly fixtures: readonly AmbientFixture[];
  readonly spawner?: RiderSpawner;
  readonly staffSpawner?: StaffSpawner;
  readonly accountSpawner?: AccountRiderSpawner;
}

/**
 * The live scored source (GH117-PLAN.md "Part C" and "Part D"). Present, it REPLACES
 * the pre-generated `generator` as the pipeline's Ingest source: the cast-stepping tick
 * listener formats each `scored-scenario` kiosk reading through `toEvent`, assigns the
 * next dense id in emission order, and offers it into `ingress`; the Ingest node pumps
 * it. When the tick loop passes `lastScoredTick` the engine closes `ingress`, so the
 * pipeline drains and finalizes once. Takes effect only alongside `scenarioCast` (its
 * offers come from the stepped cast). Omitted, scoring runs off `generator` exactly as
 * before — the reference path parity guard 2 compares against.
 */
export interface ScoredIngestSource {
  ingress: ScoredIngress;
  toEvent: (timed: TimedReading<WorldReading>, id: number) => PipeEvent;
  lastScoredTick: number;
}

/** The outcome the engine chose at one checkpoint, reported through `onCheckpoint`. */
type CheckpointOutcome = "pass" | "queue" | "correctness" | "won";

/**
 * A TEST-ONLY observation of one checkpoint evaluation (GH117-PLAN.md "Parity guards",
 * guard 2). Checkpoints are evaluated but not published in a normal run, so the paired
 * engine-equivalence test needs this seam to compare the live and reference engines at
 * each checkpoint tick. Inert in production: the run controller never passes a handler.
 */
export interface CheckpointObservation {
  /** The checkpoint's tick. */
  atTick: number;
  /** Its index in the checkpoint list. */
  index: number;
  /** Outstanding Events (admitted minus completed) the checkpoint saw. */
  queued: number;
  admitted: number;
  completed: number;
  /** The scorer's rolling Correctness at the checkpoint boundary. */
  correctness: number;
  /** The outcome the engine chose from that state. */
  outcome: CheckpointOutcome;
}

/** Everything the engine reads from the outside. Injected so tests stay pure. */
export interface StartOptions {
  getGraph: () => { nodes: GraphNode[]; edges: GraphEdge[] };
  setSnapshot: (snapshot: SimSnapshot) => void;
  /** The player's loaded Rule. */
  algorithm: TaskAlgorithm;
  /** The Correctness scorer, fresh per run. */
  scorer: Scorer;
  /** The Ingest source: the scheduled Events, then null when exhausted. */
  generator: () => PipeEvent | null;
  /** The quantized per-Event service rate the Detect governor charges. */
  serviceRate: ServiceRate;
  /** The wave boundaries plus the final deadline, in tick order. */
  checkpoints: Checkpoint[];
  /** The wave boundaries the sampler reads to publish `snapshot.wave` each tick. */
  waves: Wave[];
  /**
   * The arrival shape `waves`/`checkpoints` were built with (GH124-PLAN.md
   * Checkpoint 3). Defaults to `"waves"`, the original climbing ramp: startup
   * validation (`assertWaveScheduleOrdered`) and the sampler both read it, so a
   * `"steady"` run's gap-0 waves pass validation and the sampler publishes
   * `calm` for the whole run instead of deriving `incoming`/`active` off a
   * schedule shape steady never intends the UI to read as a wave cue.
   */
  scheduleMode?: ScheduleMode;
  /**
   * The instantiated scenario cast the engine steps on its own single Clock to
   * publish map presence and wrong-PIN / sign-in flashes (GH117-PLAN.md "Part B").
   * Optional: omitted, the engine runs exactly as before — scoring always runs off
   * `generator`, never this cast, so it is untouched whether a cast is present or not.
   */
  scenarioCast?: ScenarioCast;
  /**
   * The metro's ambient life, folded onto the same Clock and schedule as `scenarioCast`
   * (GH117-PLAN.md "Part B"). Takes effect only alongside `scenarioCast`, whose `env` and
   * `runSeed` it shares. Omitted, the engine steps the scenario cast alone. Its readings
   * are visual and log-only: scoring always runs off `generator`, never this cast.
   */
  ambientCast?: AmbientCast;
  /**
   * The live scored source (GH117-PLAN.md "Part C"). Present, the pipeline scores off
   * the stepped scenario cast instead of `generator`, and the engine closes it at the
   * scored horizon. Takes effect only alongside `scenarioCast`. Omitted, scoring runs
   * off `generator` exactly as before.
   */
  scoredIngest?: ScoredIngestSource;
  /** Defaults to a real setInterval driver; tests pass a manual one. */
  driver?: TickDriver;
  /** Reports an engine or Rule failure. */
  onError?: (error: unknown) => void;
  /**
   * TEST-ONLY: observe each checkpoint as the engine evaluates it (parity guard 2).
   * Inert in production — the run controller never passes it.
   */
  onCheckpoint?: (observation: CheckpointObservation) => void;
  /**
   * TEST-ONLY: observe a chaos wave's resolution at its drain watermark
   * (GH126-PLAN.md M2b). Inert in production — the run controller never passes it;
   * the engine's own minimal exposure is a console log. M3 adds the store fields and
   * the banner.
   */
  onWaveOutcome?: (observation: WaveOutcomeObservation) => void;
}

/** A running engine. `stop` tears it down; `whenStopped` settles for tests. */
export interface EngineHandle {
  stop: () => void;
  /** Freeze the run: hold the live clock. A no-op after stop. */
  pause: () => void;
  /** Unfreeze the run: resume the live clock. A no-op after stop. */
  resume: () => void;
  /** Change the run's pace: multiply the live clock's rate. A no-op after stop. */
  setSpeed: (multiplier: number) => void;
  /**
   * Splice one bounded chaos wave into the running clock (GH126-PLAN.md M2b). It
   * captures the live tick, rebases and admits the attacker, and registers its
   * attack, all without ever stopping the engine. Returns the minted `WaveId`, or
   * `null` when it is a no-op: outside endless mode, with no scored ingress, after
   * stop, or while a wave is already active (the cooldown, Q7).
   */
  triggerWave: () => WaveId | null;
  whenStopped: Promise<void>;
}

/** Run one teardown step in isolation, so a throw cannot skip the others. */
function teardownStep(label: string, step: () => void): void {
  try {
    step();
  } catch (error) {
    console.error(`Detection Express: ${label} threw during teardown:`, error);
  }
}

/**
 * A node's wiring, read off the edges: the edge it targets is its input, the edge
 * it sources is its output. In the four-node chain each middle node has both; the
 * Ingest has only an output and the Sink only an input.
 */
function wiringFor(
  nodeId: string,
  edges: GraphEdge[],
  channels: Map<string, Channel<PipeMessage>>,
): NodeWiring {
  let input: Channel<PipeMessage> | undefined;
  let output: Channel<PipeMessage> | undefined;
  for (const edge of edges) {
    if (edge.target === nodeId) {
      input = channels.get(edge.id);
    }
    if (edge.source === nodeId) {
      output = channels.get(edge.id);
    }
  }
  return { input, output };
}

/** The live run counters and lifecycle the sampler folds into every snapshot. */
interface RunState {
  compute: number;
  getAdmitted: () => number;
  getCompleted: () => number;
  getStatus: () => RunStatus;
  getFailureReason: () => FailureReason;
}

/**
 * Build the shared snapshot builder. It runs every tick in normal mode (gated on
 * elapsed ticks) and once per terminal transition in forced mode. A forced publish
 * with no ticks elapsed keeps the prior throughput, but always refreshes Queue,
 * Correctness, and the run counters, so the terminal reading cannot drift.
 */
/**
 * The map view the sampler folds into each snapshot (GH117-PLAN.md "Part B"). The
 * cast stepper owns the authoritative state and exposes it through these getters, so
 * the sampler reads one consistent view per publish. With no scenario cast, the
 * defaults keep the map fields empty and `nowTick` at 0, exactly as before.
 */
interface MapView {
  getActors: () => readonly ActorView[];
  getFlashes: () => readonly FlashEvent[];
  getNowTick: () => number;
  getDoors: () => readonly DoorView[];
  getCrowds: () => readonly CrowdView[];
  getWorldEvents: () => readonly WorldLogEvent[];
}

/**
 * The wave reading `"steady"` and `"endless"` mode always publish: calm, forever,
 * no matter the ticks. `"endless"` (GH126-PLAN.md M1) carries no waves at all, so
 * `waveStateAt` would have nothing to derive a phase from anyway; this constant
 * makes that explicit rather than relying on an empty-array coincidence.
 */
const STEADY_WAVE_READING: WaveReading = {
  phase: "calm",
  index: null,
  ticksUntilNext: null,
  eventsPerTick: null,
};

function makeSampler(
  clock: Clock,
  channels: Map<string, Channel<PipeMessage>>,
  scorer: Scorer,
  inspector: Inspector,
  setSnapshot: (snapshot: SimSnapshot) => void,
  run: RunState,
  waves: readonly Wave[],
  map: MapView,
  scheduleMode: ScheduleMode,
): (force: boolean) => void {
  const ticksPerSample = CLOCK_HZ / PUBLISH_HZ;
  const throughputSamples = Math.round((THROUGHPUT_WINDOW_MS * PUBLISH_HZ) / 1000);
  const throughputRate = makeWindowedRate(throughputSamples, PUBLISH_HZ);

  let lastSampleTick = clock.now();
  let lastCompleted = 0;
  let throughput = 0;
  // Cached decisions read: `decisions()` allocates a frozen copy on every call, so the
  // sampler only re-reads it when `decisionCount()` grew. The log is append-only, so
  // count equality means identity: reusing the prior array reference is always correct.
  let lastDecisionCount = scorer.decisionCount();
  let decisions = scorer.decisions();

  return (force: boolean): void => {
    const now = clock.now();
    const ticks = now - lastSampleTick;
    if (!force && ticks < ticksPerSample) {
      return;
    }

    // With real elapsed ticks, refresh throughput from the exact per-sample delta.
    // A forced publish at zero elapsed ticks skips this and keeps the prior value.
    if (ticks > 0) {
      const completedNow = run.getCompleted();
      throughput = throughputRate(completedNow - lastCompleted);
      lastCompleted = completedNow;
      lastSampleTick = now;
    }

    // Queue, Correctness, and the run counters are always fresh, even on a
    // zero-tick forced publish.
    let queued = 0;
    for (const channel of channels.values()) {
      queued += channel.size;
    }

    const decisionCount = scorer.decisionCount();
    if (decisionCount !== lastDecisionCount) {
      decisions = scorer.decisions();
      lastDecisionCount = decisionCount;
    }

    const ring = inspector.snapshot();
    setSnapshot({
      queued,
      throughput,
      correctness: scorer.reading(),
      compute: run.compute,
      status: run.getStatus(),
      failureReason: run.getFailureReason(),
      admitted: run.getAdmitted(),
      completed: run.getCompleted(),
      findings: scorer.liveFindings(),
      decisions,
      events: ring.events,
      processed: ring.processed,
      wave:
        scheduleMode === "steady" || scheduleMode === "endless"
          ? STEADY_WAVE_READING
          : waveStateAt(now, waves, WAVE_WARN_TICKS),
      scheduleMode,
      // GH117 Part B: the merged snapshot's map fields. The cast stepper folds the whole
      // living metro — scenario cast plus ambient life — into one authoritative view the
      // sampler reads here: presence, every sensor's flashes, the door and crowd reducer
      // output, and the bounded newest-first sensor log. With no cast these read empty.
      actors: map.getActors(),
      flashes: map.getFlashes(),
      doors: map.getDoors(),
      crowds: map.getCrowds(),
      nowTick: map.getNowTick(),
      worldEvents: map.getWorldEvents(),
    });
  };
}

export function start(options: StartOptions): EngineHandle {
  if (CLOCK_HZ % PUBLISH_HZ !== 0) {
    throw new Error(
      `CLOCK_HZ (${CLOCK_HZ}) must be a whole multiple of PUBLISH_HZ (${PUBLISH_HZ}).`,
    );
  }

  const graph = options.getGraph();
  const scheduleMode: ScheduleMode = options.scheduleMode ?? "waves";
  validateLinearChain(graph.nodes, graph.edges); // throws before allocation
  assertWaveScheduleOrdered(options.waves, scheduleMode); // throws before allocation
  // scoredIngest only ever offers or closes inside the `if (cast)` branch below, so
  // without a scenarioCast nothing ever calls ingress.offer/close: Ingest parks on
  // take() forever, admitted stays 0, and a queued === 0 terminal checkpoint reports a
  // false "won". Reject the misuse at setup instead of letting it silently hang.
  if (options.scoredIngest && !options.scenarioCast) {
    throw new Error("start: scoredIngest requires scenarioCast, or its Ingest never admits.");
  }

  let clock: Clock | null = null;
  let channels: Map<string, Channel<PipeMessage>> | null = null;
  let publish: ((force: boolean) => void) | null = null;
  // The chaos-wave trigger (GH126-PLAN.md M2b). Assigned inside the `if (cast)`
  // branch, where the schedule, scorer, and scored ingress it needs all live. With
  // no cast (a legacy scored-only run) it stays this no-op, so the handle's
  // `triggerWave` is always safe to call.
  let triggerWaveImpl: () => WaveId | null = () => null;
  let stopped = false;
  let admitted = 0; // real Events pushed out of Ingest
  let completed = 0; // Events drained at the Sink
  let status: RunStatus = "running";
  let failureReason: FailureReason = null;

  const compute = options.serviceRate.den / options.serviceRate.num; // 1 / serviceRate

  let resolveTerminal: () => void = () => undefined;
  const whenStopped = new Promise<void>((resolve) => {
    resolveTerminal = resolve;
  });

  // Pure teardown: idempotent, publishes nothing, and resolves the terminal
  // deferred. Every terminal path (deadline, failed checkpoint, task failure,
  // explicit stop) ends here.
  const stop = (): void => {
    if (stopped) {
      return;
    }
    stopped = true;
    teardownStep("clock.stop", () => clock?.stop());
    // Cancel any parked pump waiter through the same supervision as the clock and
    // channel waiters (GH117-PLAN.md "Part C", teardown). A pump parked on `take()`
    // (horizon not yet passed, an early checkpoint failure ended the run) unwinds only
    // through fail(); one parked on the clock gate unwinds through clock.stop() above.
    teardownStep("scoredIngest.fail", () =>
      options.scoredIngest?.ingress.fail(new ClockStoppedError()),
    );
    if (channels) {
      for (const channel of channels.values()) {
        teardownStep("channel.close", () => channel.close());
      }
    }
    resolveTerminal();
  };

  // Force-publish the terminal snapshot, guarded: a throwing setSnapshot must not
  // strand teardown, and a re-throw on the forced call is swallowed too.
  const forcePublish = (): void => {
    if (!publish) {
      return;
    }
    try {
      publish(true);
    } catch (error) {
      console.error("Detection Express: terminal publish threw:", error);
    }
  };

  // A game outcome: set the status, force-publish the terminal frame, then tear
  // down. The HUD always sees the outcome before the engine goes away.
  const finishOutcome = (nextStatus: RunStatus, reason: FailureReason): void => {
    if (stopped) {
      return;
    }
    status = nextStatus;
    failureReason = reason;
    forcePublish();
    stop();
  };

  // A failure. A thrown Rule (a task failure) is a failed outcome, so it publishes
  // the terminal frame. A throwing sampler cannot publish, so that path skips it.
  const fail = (error: unknown, publishTerminal = true): void => {
    if (stopped) {
      return;
    }
    status = "failed";
    failureReason = null;
    if (publishTerminal) {
      forcePublish();
    }
    stop(); // tear down first, so a throwing onError cannot leak the engine
    try {
      options.onError?.(error);
    } catch (handlerError) {
      console.error("Detection Express onError handler threw:", handlerError);
    }
  };

  try {
    const driver = options.driver ?? intervalDriver(CLOCK_HZ);
    clock = new Clock(CLOCK_HZ, driver);

    // One bounded channel per edge. The chain has three edges: Ingest->Normalize,
    // Normalize->Detect, Detect->Sink.
    const channelMap = new Map<string, Channel<PipeMessage>>();
    for (const edge of graph.edges) {
      channelMap.set(edge.id, new Channel<PipeMessage>(CHANNEL_CAP));
    }
    channels = channelMap; // publish to the outer scope so stop() can close each

    // GH117 Part B: the scenario-cast stepper's authoritative map view. It holds the
    // ActorView presence map and the windowed flash list; the sampler folds them into
    // every snapshot through `mapView`. Declared unconditionally so the getters read a
    // consistent empty view when no cast is injected (the existing scored-engine tests):
    // `nowTick` stays 0 and the map fields stay empty, exactly as before.
    const views = new Map<string, ActorView>();
    const mapFlashes: FlashEvent[] = [];
    let latestDoors: readonly DoorView[] = [];
    let latestCrowds: readonly CrowdView[] = [];
    let mapNowTick = 0;
    // GH124-PLAN.md Checkpoint 5: the bounded world-event ring, declared unconditionally
    // (like the inspector below) so `worldEvents` reads empty with no cast attached,
    // exactly as the other map fields do.
    const worldLog: WorldLog = createWorldLog(WORLD_LOG_RING_SIZE);
    const mapView: MapView = {
      getActors: () => [...views.values()],
      getFlashes: () => [...mapFlashes],
      getNowTick: () => mapNowTick,
      getDoors: () => latestDoors.map((door) => ({ ...door })),
      getCrowds: () => latestCrowds.map((crowd) => ({ ...crowd })),
      getWorldEvents: () => worldLog.snapshot(),
    };

    // The cast stepper, on this same single Clock. Scoring is untouched — it always
    // runs off `options.generator`; this only advances the cast for the map. Speed is
    // Clock.setSpeed pacing only, so the schedule advances one integer tick per game
    // tick regardless of speed, and the tick sequence never changes with speed.
    // The live scored source (GH117-PLAN.md "Part C"/"Part D"). Present, the tick
    // listener offers each scored-scenario kiosk reading into it (below) and the Ingest
    // node pumps it, replacing `generator`. Its dense event id runs in emission order.
    const scoredIngest = options.scoredIngest;
    let nextScoredEventId = 0;

    const cast = options.scenarioCast;
    if (cast) {
      const ambient = options.ambientCast;
      const ambientFixtures = ambient?.fixtures ?? [];

      // One schedule for the whole living metro: the scenario cast plus the ambient
      // fixtures. The ambient fixture ids seed in the ambient domain, so every scenario
      // actor's seed and same-tick priority stay byte-identical to the scenario-only run
      // (GH117-PLAN.md "Scheduler seed isolation"). This is the parity-critical call.
      const ambientFixtureIds = new Set(ambientFixtures.map((fixture) => fixture.actor.id));
      const schedule = createSchedule({
        actors: [
          ...cast.members.map((member) => member.actor),
          ...ambientFixtures.map((fixture) => fixture.actor),
        ],
        env: cast.env,
        runSeed: cast.runSeed,
        ambientIds: ambientFixtureIds,
      });

      // The engine's actor-ID provenance registry (GH117-PLAN.md "Part D"): every
      // scenario member keeps its own provenance, every ambient fixture is `"ambient"`,
      // and each runtime ambient admission adds itself below. The next step reads this to
      // enforce the scoring boundary; here it tags the actors and their readings.
      const provenanceById = new Map<string, ActorProvenance>();
      for (const member of cast.members) {
        provenanceById.set(member.actor.id, member.provenance);
      }
      for (const fixture of ambientFixtures) {
        provenanceById.set(fixture.actor.id, "ambient");
      }

      // Seed each non-dormant actor's view from its first tick, as the world engine seeds
      // its fixtures (world-engine.ts). A member that starts dormant is omitted.
      const initial = schedule.initialTicks();
      const seedView = (
        id: string,
        kind: ActorView["kind"],
        presence: Presence,
        provenance: ActorProvenance,
      ): void => {
        views.set(id, { id, kind, presence, provenance });
      };
      for (const member of cast.members) {
        const firstTick = initial.get(member.actor.id);
        if (firstTick !== undefined) {
          seedView(
            member.actor.id,
            member.kind,
            member.initialPresence(firstTick),
            member.provenance,
          );
        }
      }
      for (const fixture of ambientFixtures) {
        const firstTick = initial.get(fixture.actor.id);
        if (firstTick !== undefined) {
          seedView(fixture.actor.id, fixture.kind, fixture.initialPresence(firstTick), "ambient");
        }
      }

      // GH126-PLAN.md M2b: the one active chaos wave, plus the monotonic id counters
      // that mint its WaveId and scorer attackId. `activeWave` non-null IS the
      // cooldown (Q7). The counters never reuse a value (finding 5); the attackId is
      // a scorer key, a separate namespace from the dense scored event id.
      let activeWave: ActiveWave | null = null;
      let nextWaveId = 0;
      let nextAttackId = 0;

      // Read whether a wave's attack resolved caught, off the scorer's own decision
      // log, keyed by attackId (GH126-PLAN.md M2b). A caught or missed decision
      // always exists by the time this runs: the attack was caught during the wave,
      // or `resolveWave`'s `advanceTo` settled it missed just before. Absent (only if
      // the log's cap trimmed it) reads as not caught.
      const waveCaught = (attackId: number): boolean => {
        for (const decision of options.scorer.decisions()) {
          if (
            (decision.outcome === "caught" || decision.outcome === "missed") &&
            decision.attackId === attackId
          ) {
            return decision.outcome === "caught";
          }
        }
        return false;
      };

      // Resolve the wave at its drain watermark: settle a still-pending attack as
      // missed (the existing `closeExpired` path via `advanceTo`; a caught attack is
      // already resolved, so this is a no-op for it), read caught-vs-missed and the
      // queue peak, then clear the cooldown. NEVER `finishOutcome`, `stop`, or close
      // the ingress: the engine runs on into calm.
      const resolveWave = (wave: ActiveWave): void => {
        options.scorer.advanceTo(wave.drainDeadline);
        const caughtCount = wave.attacks.filter((attack) => waveCaught(attack.attackId)).length;
        const attackCount = wave.attacks.length;
        const allCaught = caughtCount === attackCount;
        const outcome: WaveOutcomeKind =
          allCaught && wave.queuePeak <= QUEUE_CAP ? "held" : "breach";
        activeWave = null; // lift the cooldown; every attacker is already dormant
        console.info(
          `Detection Express: chaos wave ${wave.waveId} resolved ${outcome} ` +
            `(${caughtCount}/${attackCount} attacks caught, queue peak ${wave.queuePeak}).`,
        );
        options.onWaveOutcome?.({
          waveId: wave.waveId,
          outcome,
          attackCount,
          caughtCount,
          allCaught,
          queuePeak: wave.queuePeak,
        });
      };

      // Splice one chaos wave into the running clock (GH126-PLAN.md M2b "Target
      // architecture"). In strict order: capture the live tick, mint the ids, plan
      // the rebased wave, register the attack BEFORE any evidence, then admit the
      // attacker and start the cooldown.
      const triggerWave = (): WaveId | null => {
        // Endless-mode only, one wave at a time (Q7). No-op after stop, without a
        // scored ingress to offer into, or while a wave is still active.
        if (stopped || scheduleMode !== "endless" || !scoredIngest || activeWave) {
          return null;
        }
        // The trigger tick, captured atomically from the live clock, not a UI
        // snapshot (finding 4). The admit frontier is `clock.now() + 1` after this
        // tick's `foldTick`, so the attacker's start sits a margin past it.
        const triggerTick = clock?.now() ?? 0;
        const waveId: WaveId = ++nextWaveId;
        const startTick = triggerTick + WAVE_TRIGGER_MARGIN_TICKS;
        const plan = planChaosWave(
          startTick,
          (index) => `wave-${waveId}-attacker-${index}`,
          randomLcg(waveSeed(cast.runSeed, triggerTick)),
        );

        // Admit each planned attacker in order. Per attacker: mint a unique global
        // attackId, register the pending attack BEFORE any evidence is offered or
        // scored (findings 1, 6, N2), then admit and seed its view. The scorer's
        // default matches by reason, so `entity` is informational and `windowEnd`
        // drives the miss; every attack shares the one window.
        const attacks: ActiveWaveAttack[] = [];
        for (const planned of plan.attackers) {
          const attackId = ++nextAttackId;
          options.scorer.addAttack({
            attackId,
            entity: planned.victim,
            reason: PIN_BRUTE_FORCE_REASON,
            threshold: plan.threshold,
            windowEnd: plan.window.endTs,
          });

          const admission: Admission<WorldReading, WorldEnv> = {
            actor: planned.attacker.build(),
            kind: planned.attacker.kind,
            initialPresence: planned.attacker.initialPresence,
          };
          const firstTick = schedule.admit(admission);
          provenanceById.set(planned.actorId, "scored-scenario");
          seedView(
            planned.actorId,
            planned.attacker.kind,
            planned.attacker.initialPresence(firstTick),
            "scored-scenario",
          );

          attacks.push({
            attackId,
            actorId: planned.actorId,
            expectedEvidence: planned.evidenceCount,
            collectedEvidence: [],
          });
        }

        activeWave = {
          waveId,
          attacks,
          windowEnd: plan.window.endTs,
          drainDeadline: plan.window.endTs + WAVE_DRAIN_MARGIN_TICKS * GAME_SECONDS_PER_TICK,
          queuePeak: 0,
        };
        return waveId;
      };
      triggerWaveImpl = triggerWave;

      // The OCC node id an occ-console command flash lands on (the console reading is
      // OCC-only and carries no location of its own).
      const occId = cast.env.world.controlCenter.id;
      // The door and camera projections over the frozen env (ADR-0007): engine reducers,
      // never scheduler actors. They drive the ambient door-contact and platform-camera
      // readings, their flashes, and the crowd-density marks (world-engine.ts).
      const doorReducer = createDoorReducer(DOOR_DWELL_TICKS);
      const cameraReducer = createCameraReducer(CAMERA_WINDOW_TICKS);
      const liveOfKind = (kind: ActorView["kind"]): number =>
        [...views.values()].filter((view) => view.kind === kind).length;

      // GH124-PLAN.md Checkpoint 5: the place and (when it has one) the chip node a
      // reading's world-log row keys on. Exhaustive over `WorldReading["sensor"]`, so a
      // future sensor arm is a tsc error here, not a silent gap in the log. Mirrors the
      // node ids `applyStep`'s flash chain already raises flashes on, plus the two
      // reducer-only arms (door-contact, platform-camera) below.
      const worldLogPlace = (
        reading: WorldReading,
      ): { placeId: MapNodeId; chipNode?: MapNodeId } => {
        switch (reading.sensor) {
          case "kiosk":
            return {
              placeId: reading.reading.station,
              chipNode: kioskNodeId(reading.reading.station),
            };
          case "fare-gate":
            return {
              placeId: reading.reading.station,
              chipNode: gateNodeId(reading.reading.station),
            };
          case "train-tracker":
            // T chips exist only at a depot or a signal cabin, not at a station, so a
            // train row keys off `placeId` alone (GH124-PLAN.md Checkpoint 5).
            return { placeId: reading.reading.station };
          case "door-reader":
            return { placeId: reading.reading.site, chipNode: readerNodeId(reading.reading.site) };
          case "tvm":
            return {
              placeId: reading.reading.station,
              chipNode: tvmNodeId(reading.reading.station),
            };
          case "occ-console":
            return { placeId: occId, chipNode: consoleNodeId(occId) };
          case "network-relay":
            return { placeId: reading.reading.site, chipNode: relayNodeId(reading.reading.site) };
          case "door-contact":
            return { placeId: reading.reading.site, chipNode: contactNodeId(reading.reading.site) };
          case "platform-camera":
            return {
              placeId: reading.reading.station,
              chipNode: cameraNodeId(reading.reading.station),
            };
        }
      };

      // GH124-PLAN.md Checkpoint 5, safe-capture rules: build and push one
      // `WorldLogEvent`, never throwing. Called only AFTER the existing scored
      // offer/predicate block below has already run (so it can never race or
      // duplicate `toEvent`/`nextScoredEventId`), so a throw here can never unwind
      // past a scored offer that already succeeded. `actorId` is set only when the
      // reading came from a live actor (reducer-synthesized door-contact and
      // platform-camera readings omit it).
      const captureWorldEvent = (
        reading: WorldReading,
        ts: number,
        actorId: string | undefined,
        scored: boolean,
        scoredEventId: number | undefined,
      ): void => {
        try {
          const place = worldLogPlace(reading);
          worldLog.push({
            ts,
            sensor: reading.sensor,
            placeId: place.placeId,
            ...(place.chipNode !== undefined ? { chipNode: place.chipNode } : {}),
            ...(actorId !== undefined ? { actorId } : {}),
            reading,
            scored,
            ...(scoredEventId !== undefined ? { scoredEventId } : {}),
          });
        } catch (error) {
          console.error("Detection Express: world-log capture threw:", error);
        }
      };

      let nextFlashId = 0;
      // Fold one step: raise a flash per reading on its sensor's chip, overlay the
      // presence deltas, then evict the actors that went dormant. A kiosk fail is a
      // wrong-PIN "pinfail", a success a "signin"; the other sensor arms belong to the
      // ambient cast.
      const applyStep = (step: StepResult<WorldReading>): void => {
        for (const timed of step.readings) {
          const reading = timed.reading;
          if (reading.sensor === "kiosk") {
            mapFlashes.push({
              id: nextFlashId++,
              kind: reading.reading.outcome === "fail" ? "pinfail" : "signin",
              node: kioskNodeId(reading.reading.station),
              atTick: timed.tick,
            });
          } else if (reading.sensor === "fare-gate") {
            mapFlashes.push({
              id: nextFlashId++,
              kind: "tap",
              node: gateNodeId(reading.reading.station),
              atTick: timed.tick,
            });
          } else if (reading.sensor === "train-tracker") {
            mapFlashes.push({
              id: nextFlashId++,
              kind: "train",
              node: reading.reading.station,
              atTick: timed.tick,
            });
          } else if (reading.sensor === "door-reader") {
            mapFlashes.push({
              id: nextFlashId++,
              kind: "grant",
              node: readerNodeId(reading.reading.site),
              atTick: timed.tick,
            });
          } else if (reading.sensor === "tvm") {
            mapFlashes.push({
              id: nextFlashId++,
              kind: "topup",
              node: tvmNodeId(reading.reading.station),
              atTick: timed.tick,
            });
          } else if (reading.sensor === "occ-console") {
            mapFlashes.push({
              id: nextFlashId++,
              kind: "command",
              node: consoleNodeId(occId),
              atTick: timed.tick,
            });
          } else if (reading.sensor === "network-relay") {
            mapFlashes.push({
              id: nextFlashId++,
              kind: "packet",
              node: relayNodeId(reading.reading.site),
              atTick: timed.tick,
            });
          }
          const provenance = provenanceById.get(timed.actorId) ?? "ambient";
          // The scoring boundary (GH117-PLAN.md "Part D"): only a scored-scenario kiosk
          // reading is formatted, dense-id-assigned, and offered to the pipeline. An
          // ambient kiosk reading already raised its flash above but never enters the
          // channels, so it can never bump the dense id or `admitted`. The id runs in
          // emission order, matching the precomposed run parity guard 1 pins.
          //
          // GH124-PLAN.md Checkpoint 5, safe-capture rules: the world-log capture reads
          // `nextScoredEventId` but never increments it, and runs strictly AFTER this
          // block's own single `toEvent`/`offer` call — never before, never twice — so a
          // scored row's `scoredEventId` always matches the id this same reading was
          // actually offered under.
          if (scoredIngest && reading.sensor === "kiosk" && provenance === "scored-scenario") {
            const scoredEventId = nextScoredEventId++;
            // GH126-PLAN.md M2b, evidence bind (finding 1): a reading from one of the
            // active wave's attackers is that attack's evidence, so bind its global
            // dense id to the attack the moment it is offered — before Detect scores
            // the finding that cites it. The wave now holds several attackers, so match
            // by actorId. The attack was registered at trigger, so `owner` is populated
            // before the finding is judged, and it scores caught.
            if (activeWave) {
              const attack = activeWave.attacks.find((a) => a.actorId === timed.actorId);
              if (attack) {
                options.scorer.bindEvidence(attack.attackId, scoredEventId);
                attack.collectedEvidence.push(scoredEventId);
              }
            }
            scoredIngest.ingress.offer(scoredIngest.toEvent(timed, scoredEventId));
            captureWorldEvent(reading, reading.reading.ts, timed.actorId, true, scoredEventId);
          } else {
            captureWorldEvent(reading, reading.reading.ts, timed.actorId, false, undefined);
          }
        }
        for (const [id, presence] of step.presences) {
          const view = views.get(id);
          if (view !== undefined) {
            views.set(id, { ...view, presence });
          }
        }
        // GH124-PLAN.md Checkpoint 4 Part 2: overlay the tick's destination deltas the
        // same way `presences` does above, in its own loop since it is its own delta
        // map. `destinations` uses `MapNodeId | null`, not `MapNodeId | undefined`, so
        // an explicit clear (`null`) is a real delta this loop applies — by dropping
        // the key entirely, never by assigning it `undefined` (an `exactOptionalPropertyTypes`
        // violation: `ActorView.destination` being unset and being present-but-undefined
        // are not the same type here).
        for (const [id, destination] of step.destinations) {
          const view = views.get(id);
          if (view === undefined) {
            continue;
          }
          if (destination === null) {
            const { destination: _cleared, ...rest } = view;
            views.set(id, rest);
          } else {
            views.set(id, { ...view, destination });
          }
        }
        // Evict the dormant actor from both registries, or provenanceById grows with
        // total admissions instead of live actors on a perpetual run. Safe: this
        // step's readings (above) already read provenance before this loop runs, and
        // ids are never reused (createSchedule reserves every startup id; the
        // spawners mint monotonic ids), so no later actor can inherit a stale entry.
        for (const id of step.dormant) {
          views.delete(id);
          provenanceById.delete(id);
        }
      };

      // Run the door reducer for one tick over that tick's staff grants, AFTER the actor
      // readings are logged. It closes doors past their dwell and opens the tick's grants;
      // each open/close raises a flash on the door-contact chip. Refresh the open-door
      // marks too.
      const reduceDoors = (step: StepResult<WorldReading>, tick: number): void => {
        const grants: { location: string; door: string }[] = [];
        for (const timed of step.readings) {
          if (timed.reading.sensor === "door-reader") {
            grants.push({ location: timed.reading.reading.site, door: timed.reading.reading.door });
          }
        }
        for (const event of doorReducer.step(grants, tick)) {
          mapFlashes.push({
            id: nextFlashId++,
            kind: "door",
            node: contactNodeId(event.location),
            atTick: tick,
          });
          // GH124-PLAN.md Checkpoint 5, capture site 2: a reducer-synthesized
          // door-contact reading, one per open/close event, no actorId (the door
          // reducer is an engine projection, not an actor). Always unscored: only a
          // kiosk reading can ever cross the #117 boundary.
          captureWorldEvent(
            {
              sensor: "door-contact",
              reading: {
                ts: tick * GAME_SECONDS_PER_TICK,
                site: event.location,
                door: event.door,
                event: event.event,
              },
            },
            tick * GAME_SECONDS_PER_TICK,
            undefined,
            false,
            undefined,
          );
        }
        const openNodes = new Set(
          doorReducer.openDoors().map((door) => contactNodeId(door.location)),
        );
        latestDoors = [...openNodes].map((node) => ({ node, open: true }));
      };

      // GH124-PLAN.md Checkpoint 5, camera on-change tracking: the last per-gate total
      // this reduceCamera call itself logged, so a tick whose window sum is unchanged
      // logs nothing. A gate that drops out of the reducer's output (its window emptied)
      // logs exactly one zero, the moment it disappears, then nothing further — this map
      // still holding it at zero is what suppresses every later re-log.
      const previousCameraTotals = new Map<
        string,
        { station: string; grants: number; persons: number }
      >();

      // Run the camera reducer for one tick over that tick's fare-gate grants, AFTER the
      // door reducer, so the fixed source order (actor, door, camera) holds. It counts the
      // grants per gate over a rolling window and refreshes the crowd marks.
      const reduceCamera = (step: StepResult<WorldReading>, tick: number): void => {
        const grants: CameraGrant[] = [];
        for (const timed of step.readings) {
          if (timed.reading.sensor === "fare-gate" && timed.reading.reading.result === "ok") {
            const station = timed.reading.reading.station;
            const gate = gateIdForStation(station);
            grants.push({ station, gate });
          }
        }
        const counts = cameraReducer.step(grants, tick);
        latestCrowds = counts.map((count) => ({
          node: cameraNodeId(count.station),
          persons: count.persons,
          grants: count.grants,
        }));

        // GH124-PLAN.md Checkpoint 5, capture site 3: log a gate's windowed count only
        // when it changed, including the change TO zero on grant expiry. Never log a
        // tick's rolling total just because it repeats unchanged.
        const seenGates = new Set<string>();
        for (const count of counts) {
          seenGates.add(count.gate);
          const previous = previousCameraTotals.get(count.gate);
          if (
            previous === undefined ||
            previous.grants !== count.grants ||
            previous.persons !== count.persons
          ) {
            captureWorldEvent(
              {
                sensor: "platform-camera",
                reading: {
                  ts: tick * GAME_SECONDS_PER_TICK,
                  station: count.station,
                  gate: count.gate,
                  grants: count.grants,
                  persons: count.persons,
                },
              },
              tick * GAME_SECONDS_PER_TICK,
              undefined,
              false,
              undefined,
            );
          }
          previousCameraTotals.set(count.gate, {
            station: count.station,
            grants: count.grants,
            persons: count.persons,
          });
        }
        // A gate the reducer no longer reports (its window emptied): log one zero, the
        // instant it disappears, then stay silent — the map now holds it at zero, so the
        // `previous === undefined` branch above never fires for it again.
        for (const [gate, previous] of previousCameraTotals) {
          if (seenGates.has(gate) || (previous.grants === 0 && previous.persons === 0)) {
            continue;
          }
          captureWorldEvent(
            {
              sensor: "platform-camera",
              reading: {
                ts: tick * GAME_SECONDS_PER_TICK,
                station: previous.station,
                gate,
                grants: 0,
                persons: 0,
              },
            },
            tick * GAME_SECONDS_PER_TICK,
            undefined,
            false,
            undefined,
          );
          previousCameraTotals.set(gate, { station: previous.station, grants: 0, persons: 0 });
        }
      };

      // Admit each ambient spawner's due births at the frontier and seed each view.
      // Each spawner is capped by its own live count. Ticked at the post-advance
      // frontier so an admission lands at or after it.
      //
      // GH126-PLAN.md M1, seam 5: under `"endless"` (the baseline), an account-rider
      // admission is tagged `"scored-scenario"`, not `"ambient"`, so its kiosk
      // readings cross the scoring boundary above and enter the baseline's scored
      // pipeline — there is no scenario cast in baseline mode to score off instead.
      // A plain rider or staff admission always stays `"ambient"`: visual only,
      // never scored. Outside `"endless"` (a blueprint-driven `"waves"`/`"steady"`
      // run), every ambient admission stays `"ambient"` exactly as before: that
      // scenario's own cast members already carry `"scored-scenario"` provenance,
      // and promoting the ambient account rider too would double-score against the
      // precomposed run the parity guards check against (GH117-PLAN.md guard 1).
      const spawnTransients = (frontier: number): void => {
        const admit = (admissions: readonly Admission<WorldReading, WorldEnv>[]): void => {
          for (const admission of admissions) {
            const firstTick = schedule.admit(admission);
            const provenance: ActorProvenance =
              admission.kind === "account-rider" && scheduleMode === "endless"
                ? "scored-scenario"
                : "ambient";
            provenanceById.set(admission.actor.id, provenance);
            seedView(
              admission.actor.id,
              admission.kind,
              admission.initialPresence(firstTick),
              provenance,
            );
          }
        };
        admit(ambient?.spawner?.tick(frontier, liveOfKind("rider")) ?? []);
        admit(ambient?.staffSpawner?.tick(frontier, liveOfKind("staff")) ?? []);
        admit(ambient?.accountSpawner?.tick(frontier, liveOfKind("account-rider")) ?? []);
      };

      // Drop flashes older than the window behind the current tick, so the list stays
      // bounded on a perpetual run (world-engine.ts).
      const pruneFlashes = (): void => {
        const cutoff = mapNowTick - FLASH_WINDOW_TICKS;
        let drop = 0;
        while (drop < mapFlashes.length && (mapFlashes[drop]?.atTick ?? mapNowTick) < cutoff) {
          drop += 1;
        }
        if (drop > 0) {
          mapFlashes.splice(0, drop);
        }
      };

      // Fold one whole game tick `tick` (the tick just becoming due): advance the schedule
      // one integer tick, apply the readings, run the door then camera reducers over that
      // tick's grants, admit the ambient spawners at the new frontier (tick + 1), then set
      // the map's authoritative tick and prune the flash window.
      const foldTick = (tick: number): void => {
        const step = schedule.advanceTo(tick + 1);
        applyStep(step);
        reduceDoors(step, tick);
        reduceCamera(step, tick);
        spawnTransients(tick + 1);
        mapNowTick = tick;
        pruneFlashes();
        // Scored horizon (GH117-PLAN.md "Part C"): once this tick reaches the last
        // scored emission tick, every scored event for the run has been offered above,
        // so close the ingress. The pipeline then drains, END_OF_STREAM fires
        // scorer.finalize once, and the run concludes. Idempotent, so a later tick
        // re-calling it is a no-op; no scored reading emits past the horizon, so no
        // offer ever races an already-closed ingress.
        if (scoredIngest && tick >= scoredIngest.lastScoredTick) {
          scoredIngest.ingress.close();
        }

        // GH126-PLAN.md M2b: while a chaos wave is active, peak its in-flight
        // backlog, then resolve it at the drain watermark. Guarded on `scoredIngest`
        // because an active wave only ever exists alongside one (triggerWave's guard).
        if (activeWave && scoredIngest) {
          const wave = activeWave;
          // The wave-scoped queue metric (finding 8, seam 12): the peak of
          // `offered - processed` expressed as the live backlog — the ScoredIngress
          // buffer PLUS every channel's contents, not only channel sizes. Reset to
          // zero at wave start, so it measures this wave's window alone.
          let backlog = scoredIngest.ingress.size;
          for (const channel of channelMap.values()) {
            backlog += channel.size;
          }
          if (backlog > wave.queuePeak) {
            wave.queuePeak = backlog;
          }
          // Resolve once EVERY attacker's fails have all been offered and bound, Detect
          // has processed the wave's last evidence id across all attacks (`completed` is
          // a dense FIFO count, so `completed > lastId` means that id cleared the
          // pipeline), and the drain deadline passed. A queued-evidence case is never
          // resolved early.
          let totalExpected = 0;
          let totalCollected = 0;
          let lastId = -1;
          for (const attack of wave.attacks) {
            totalExpected += attack.expectedEvidence;
            totalCollected += attack.collectedEvidence.length;
            const attackLast = attack.collectedEvidence[attack.collectedEvidence.length - 1];
            if (attackLast !== undefined && attackLast > lastId) {
              lastId = attackLast;
            }
          }
          if (
            totalCollected >= totalExpected &&
            lastId >= 0 &&
            completed > lastId &&
            tick * GAME_SECONDS_PER_TICK >= wave.drainDeadline
          ) {
            resolveWave(wave);
          }
        }
      };

      // Tick zero: prime the schedule once at startup, before the clock loop, with
      // foldTick(0) (advanceTo(1), NOT advanceTo(0), which emits nothing under the
      // half-open rule). Any ts=0 reading is folded now; now() is still 0 here.
      foldTick(0);

      // The actor-stepping tick listener, registered FIRST — before the sampler and the
      // checkpoint listener — so this tick's presence is already folded when the sampler
      // publishes and the enqueue would sit ahead of admission (Part C). Each game tick
      // folds now() (one integer tick), so a reading emitted on tick T carries atTick
      // T <= nowTick. A throwing actor is a failed outcome, like a task.
      clock.onTick(() => {
        if (stopped) {
          return;
        }
        try {
          foldTick(clock?.now() ?? 0);
        } catch (error) {
          fail(error);
        }
      });
    }

    // The inspector needs no ground truth, so the engine builds it directly. This
    // is a deliberate asymmetry with the scorer, which the run controller injects.
    const inspector = createInspector({ ringSize: RING_SIZE });
    // Late-bind the scorer's event resolver to this run's own fresh inspector
    // (correctness.ts's `bindEventResolver` doc): the run controller builds the
    // scorer before this inspector exists, so the two halves pair here, every time
    // a run commits, never carrying a stale binding across an Apply, a hot reload,
    // or a restart.
    options.scorer.bindEventResolver((ids) => inspector.resolveEvents(ids));

    const runtime: NodeRuntime = {
      clock,
      onComplete: () => {
        completed += 1;
      },
      onAdmit: () => {
        admitted += 1;
      },
      algorithm: options.algorithm,
      scorer: options.scorer,
      inspector,
      nextEvent: options.generator,
      // The live scored source replaces the pull schedule when injected (GH117 Part C).
      ...(scoredIngest
        ? {
            pump: (out, tickClock, onAdmit): Promise<void> =>
              scoredIngest.ingress.pump(out, tickClock, onAdmit),
          }
        : {}),
      serviceRate: options.serviceRate,
    };
    // Spawn one task per node, looked up by kind. A thrown Rule rejects its task
    // and routes through fail() as a failed outcome.
    const tasks = graph.nodes.map((node) => {
      const task = NODE_TASKS.get(node.kind);
      if (!task) {
        throw new Error(`No task is registered for node kind "${node.kind}".`);
      }
      return task(node.id, wiringFor(node.id, graph.edges, channelMap), runtime).catch(fail);
    });
    // The marker draining ends every task cleanly; the Detect task already finalized
    // Correctness. The run does NOT end here: it waits for the final deadline.
    void Promise.allSettled(tasks);

    publish = makeSampler(
      clock,
      channelMap,
      options.scorer,
      inspector,
      options.setSnapshot,
      {
        compute,
        getAdmitted: () => admitted,
        getCompleted: () => completed,
        getStatus: () => status,
        getFailureReason: () => failureReason,
      },
      options.waves,
      mapView,
      scheduleMode,
    );

    // The per-tick sampler. A throwing setSnapshot is a sampler failure, so it
    // does not try to force-publish through the same broken sink.
    const doPublish = publish;
    clock.onTick(() => {
      if (stopped) {
        return;
      }
      try {
        doPublish(false);
      } catch (error) {
        fail(error, false);
      }
    });

    // Checkpoint evaluation, at the start-of-tick boundary, before task
    // continuations resume. An Event whose service sleep is due on the checkpoint
    // tick has not run its push yet, so it counts as still outstanding.
    const checkpoints = options.checkpoints;
    let nextCheckpoint = 0;
    clock.onTick(() => {
      if (stopped) {
        return;
      }
      const now = clock?.now() ?? 0;
      while (nextCheckpoint < checkpoints.length) {
        const cp = checkpoints[nextCheckpoint];
        if (!cp || cp.atTick > now) {
          break;
        }
        options.scorer.advanceTo(cp.atTick * GAME_SECONDS_PER_TICK);
        const queued = admitted - completed;
        const isFinal = nextCheckpoint === checkpoints.length - 1;
        const rolling = options.scorer.reading().rolling;
        // The outcome this checkpoint state implies, computed once so the test-only
        // observation seam (parity guard 2) and the terminal transitions read the same
        // decision. `pass` clears an interim checkpoint; the other three are terminal.
        const outcome: CheckpointOutcome =
          queued !== 0
            ? "queue"
            : rolling < CORRECTNESS_FLOOR
              ? "correctness"
              : isFinal
                ? "won"
                : "pass";
        options.onCheckpoint?.({
          atTick: cp.atTick,
          index: nextCheckpoint,
          queued,
          admitted,
          completed,
          correctness: rolling,
          outcome,
        });
        if (outcome === "queue") {
          finishOutcome("failed", "queue");
          return;
        }
        if (outcome === "correctness") {
          finishOutcome("failed", "correctness");
          return;
        }
        if (outcome === "won") {
          finishOutcome("won", null);
          return;
        }
        nextCheckpoint += 1;
      }
    });

    // The clock is live from here on. pause/resume drive the freeze control seam and
    // setSpeed drives the speed seam; the Clock guards each against a stopped state,
    // so they are safe after stop.
    return {
      stop,
      pause: () => clock?.pause(),
      resume: () => clock?.resume(),
      setSpeed: (multiplier: number) => clock?.setSpeed(multiplier),
      triggerWave: () => triggerWaveImpl(),
      whenStopped,
    };
  } catch (error) {
    stop(); // partial teardown, so a half-built engine leaks nothing
    throw error;
  }
}
