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
import type { Checkpoint, Wave } from "../sim/scenario";
import type { ScoredIngress } from "../sim/scored-ingress";
import type { ServiceRate } from "../sim/service-governor";
import type { FailureReason, RunStatus, SimSnapshot } from "../sim/snapshot";
import { NODE_TASKS, type NodeRuntime, type NodeWiring, type TaskAlgorithm } from "../sim/tasks";
import { assertWaveScheduleOrdered } from "../sim/wave-schedule";
import { waveStateAt } from "../sim/wave-state";
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
import type { TimedWorldReading, WorldEnv, WorldReading } from "../sim/world-reading";
import type { ActorView, FlashEvent } from "../sim/world-snapshot";
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
  RING_SIZE,
  THROUGHPUT_WINDOW_MS,
  WAVE_WARN_TICKS,
  WORLD_LOG_RETENTION,
} from "./tuning";

/**
 * One member of the instantiated scenario cast the engine steps for the map
 * (GH117-PLAN.md "Part B"). It pairs a fresh actor (from `blueprint.instantiate()`)
 * with the three things the blueprint descriptor carries that the engine needs at
 * runtime: the view `kind` it draws as, its `provenance` (all `scored-scenario`
 * today; the admission filter reads it in a later step), and the `initialPresence`
 * to seed its `ActorView` with before its first `act()`. Mirrors `WorldFixture`.
 */
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
  getDoors: () => readonly { node: MapNodeId; open: boolean }[];
  getCrowds: () => readonly { node: MapNodeId; persons: number; grants: number }[];
  getMapLog: () => readonly TimedWorldReading[];
}

function makeSampler(
  clock: Clock,
  channels: Map<string, Channel<PipeMessage>>,
  scorer: Scorer,
  inspector: Inspector,
  setSnapshot: (snapshot: SimSnapshot) => void,
  run: RunState,
  waves: readonly Wave[],
  map: MapView,
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
      wave: waveStateAt(now, waves, WAVE_WARN_TICKS),
      // GH117 Part B: the merged snapshot's map fields. The cast stepper folds the whole
      // living metro — scenario cast plus ambient life — into one authoritative view the
      // sampler reads here: presence, every sensor's flashes, the door and crowd reducer
      // output, and the bounded newest-first sensor log. With no cast these read empty.
      actors: map.getActors(),
      flashes: map.getFlashes(),
      doors: map.getDoors(),
      crowds: map.getCrowds(),
      nowTick: map.getNowTick(),
      mapLog: map.getMapLog(),
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
  validateLinearChain(graph.nodes, graph.edges); // throws before allocation
  assertWaveScheduleOrdered(options.waves); // throws before allocation

  let clock: Clock | null = null;
  let channels: Map<string, Channel<PipeMessage>> | null = null;
  let publish: ((force: boolean) => void) | null = null;
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
    const mapLog: TimedWorldReading[] = [];
    let latestDoors: readonly { node: MapNodeId; open: boolean }[] = [];
    let latestCrowds: readonly { node: MapNodeId; persons: number; grants: number }[] = [];
    let mapNowTick = 0;
    const mapView: MapView = {
      getActors: () => [...views.values()],
      getFlashes: () => [...mapFlashes],
      getNowTick: () => mapNowTick,
      getDoors: () => latestDoors.map((door) => ({ ...door })),
      getCrowds: () => latestCrowds.map((crowd) => ({ ...crowd })),
      // Newest first, so the embedded log panel reads top to bottom as most-recent first.
      getMapLog: () => [...mapLog].reverse(),
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

      let nextFlashId = 0;
      // Fold one step: raise a flash per reading on its sensor's chip, append each actor
      // reading to the map log tagged with its provenance, overlay the presence deltas,
      // then evict the actors that went dormant. A kiosk fail is a wrong-PIN "pinfail", a
      // success a "signin"; the other sensor arms belong to the ambient cast.
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
          const entry: TimedWorldReading = {
            reading,
            tick: timed.tick,
            source: "actor",
            provenance,
          };
          if (timed.actorId !== undefined) {
            entry.actorId = timed.actorId;
          }
          mapLog.push(entry);
          // The scoring boundary (GH117-PLAN.md "Part D"): only a scored-scenario kiosk
          // reading is formatted, dense-id-assigned, and offered to the pipeline. An
          // ambient kiosk reading already raised its flash and log line above but never
          // enters the channels, so it can never bump the dense id or `admitted`. The
          // id runs in emission order, matching the precomposed run parity guard 1 pins.
          if (scoredIngest && reading.sensor === "kiosk" && provenance === "scored-scenario") {
            scoredIngest.ingress.offer(scoredIngest.toEvent(timed, nextScoredEventId++));
          }
        }
        for (const [id, presence] of step.presences) {
          const view = views.get(id);
          if (view !== undefined) {
            views.set(id, { ...view, presence });
          }
        }
        for (const id of step.dormant) {
          views.delete(id);
        }
      };

      // Run the door reducer for one tick over that tick's staff grants, AFTER the actor
      // readings are logged. It closes doors past their dwell and opens the tick's grants;
      // each open/close becomes a `door-contact` reading (source "door", provenance
      // ambient) and a flash on the door-contact chip. Refresh the open-door marks too.
      const reduceDoors = (step: StepResult<WorldReading>, tick: number): void => {
        const grants: { location: string; door: string }[] = [];
        for (const timed of step.readings) {
          if (timed.reading.sensor === "door-reader") {
            grants.push({ location: timed.reading.reading.site, door: timed.reading.reading.door });
          }
        }
        for (const event of doorReducer.step(grants, tick)) {
          const reading: WorldReading = {
            sensor: "door-contact",
            reading: {
              ts: tick * GAME_SECONDS_PER_TICK,
              site: event.location,
              door: event.door,
              event: event.event,
            },
          };
          mapLog.push({ reading, tick, source: "door", provenance: "ambient" });
          mapFlashes.push({
            id: nextFlashId++,
            kind: "door",
            node: contactNodeId(event.location),
            atTick: tick,
          });
        }
        const openNodes = new Set(
          doorReducer.openDoors().map((door) => contactNodeId(door.location)),
        );
        latestDoors = [...openNodes].map((node) => ({ node, open: true }));
      };

      // Run the camera reducer for one tick over that tick's fare-gate grants, AFTER the
      // door reducer, so the fixed source order (actor, door, camera) holds. It counts the
      // grants per gate over a rolling window and refreshes the crowd marks, then emits one
      // `platform-camera` reading (source "camera", provenance ambient) per gate that saw a
      // tap this tick. It trims the log last, once all three sources are appended.
      const reduceCamera = (step: StepResult<WorldReading>, tick: number): void => {
        const grants: CameraGrant[] = [];
        const tappedGates = new Set<string>();
        for (const timed of step.readings) {
          if (timed.reading.sensor === "fare-gate" && timed.reading.reading.result === "ok") {
            const station = timed.reading.reading.station;
            const gate = gateIdForStation(station);
            grants.push({ station, gate });
            tappedGates.add(gate);
          }
        }
        const counts = cameraReducer.step(grants, tick);
        latestCrowds = counts.map((count) => ({
          node: cameraNodeId(count.station),
          persons: count.persons,
          grants: count.grants,
        }));
        for (const count of counts) {
          if (!tappedGates.has(count.gate)) {
            continue;
          }
          const reading: WorldReading = {
            sensor: "platform-camera",
            reading: {
              ts: tick * GAME_SECONDS_PER_TICK,
              station: count.station,
              gate: count.gate,
              grants: count.grants,
              persons: count.persons,
            },
          };
          mapLog.push({ reading, tick, source: "camera", provenance: "ambient" });
        }
        if (mapLog.length > WORLD_LOG_RETENTION) {
          mapLog.splice(0, mapLog.length - WORLD_LOG_RETENTION);
        }
      };

      // Admit each ambient spawner's due births at the frontier and seed each view,
      // tagging every admission `"ambient"`. Each spawner is capped by its own live count.
      // Ticked at the post-advance frontier so an admission lands at or after it.
      const spawnTransients = (frontier: number): void => {
        const admit = (admissions: readonly Admission<WorldReading, WorldEnv>[]): void => {
          for (const admission of admissions) {
            const firstTick = schedule.admit(admission);
            provenanceById.set(admission.actor.id, "ambient");
            seedView(
              admission.actor.id,
              admission.kind,
              admission.initialPresence(firstTick),
              "ambient",
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
      whenStopped,
    };
  } catch (error) {
    stop(); // partial teardown, so a half-built engine leaks nothing
    throw error;
  }
}
