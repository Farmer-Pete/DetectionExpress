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
import {
  type Actor,
  type ActorProvenance,
  createSchedule,
  type StepResult,
} from "../sim/actors/actor";
import { Channel } from "../sim/channel";
import type { Scorer } from "../sim/correctness";
import type { PipeEvent, PipeMessage } from "../sim/event";
import { type GraphEdge, type GraphNode, validateLinearChain } from "../sim/graph";
import { createInspector, type Inspector } from "../sim/inspector";
import { makeWindowedRate } from "../sim/rate";
import type { Checkpoint, Wave } from "../sim/scenario";
import type { ServiceRate } from "../sim/service-governor";
import type { FailureReason, RunStatus, SimSnapshot } from "../sim/snapshot";
import { NODE_TASKS, type NodeRuntime, type NodeWiring, type TaskAlgorithm } from "../sim/tasks";
import { assertWaveScheduleOrdered } from "../sim/wave-schedule";
import { waveStateAt } from "../sim/wave-state";
import { kioskNodeId } from "../sim/world/layout";
import type { Presence } from "../sim/world/presence";
import type { WorldEnv, WorldReading } from "../sim/world-reading";
import type { ActorView, FlashEvent } from "../sim/world-snapshot";
import { Clock, intervalDriver, type TickDriver } from "./clock";
import {
  CHANNEL_CAP,
  CLOCK_HZ,
  CORRECTNESS_FLOOR,
  FLASH_WINDOW_TICKS,
  GAME_SECONDS_PER_TICK,
  PUBLISH_HZ,
  RING_SIZE,
  THROUGHPUT_WINDOW_MS,
  WAVE_WARN_TICKS,
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
  /** Defaults to a real setInterval driver; tests pass a manual one. */
  driver?: TickDriver;
  /** Reports an engine or Rule failure. */
  onError?: (error: unknown) => void;
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
      // GH117 Part B: the merged snapshot's map fields. The scenario-cast stepper folds
      // presence and wrong-PIN / sign-in flashes into an authoritative view the sampler
      // reads here; `doors`, `crowds`, and `mapLog` stay empty until their reducers land.
      actors: map.getActors(),
      flashes: map.getFlashes(),
      doors: [],
      crowds: [],
      nowTick: map.getNowTick(),
      mapLog: [],
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
    let mapNowTick = 0;
    const mapView: MapView = {
      getActors: () => [...views.values()],
      getFlashes: () => [...mapFlashes],
      getNowTick: () => mapNowTick,
    };

    // The cast stepper, on this same single Clock. Scoring is untouched — it always
    // runs off `options.generator`; this only advances the cast for the map. Speed is
    // Clock.setSpeed pacing only, so the schedule advances one integer tick per game
    // tick regardless of speed, and the tick sequence never changes with speed.
    const cast = options.scenarioCast;
    if (cast) {
      const schedule = createSchedule({
        actors: cast.members.map((member) => member.actor),
        env: cast.env,
        runSeed: cast.runSeed,
      });
      // Seed each non-dormant member's view from its first tick, as the world engine
      // seeds its fixtures (world-engine.ts). A member that starts dormant is omitted.
      const initial = schedule.initialTicks();
      for (const member of cast.members) {
        const firstTick = initial.get(member.actor.id);
        if (firstTick === undefined) {
          continue;
        }
        views.set(member.actor.id, {
          id: member.actor.id,
          kind: member.kind,
          presence: member.initialPresence(firstTick),
        });
      }

      let nextFlashId = 0;
      // Fold one step: raise a kiosk flash per reading (a sign-in success -> "signin",
      // a wrong-PIN fail -> "pinfail", both on the station's kiosk chip), overlay the
      // presence deltas, then evict the actors that went dormant this step. The scenario
      // cast is kiosk-only, so this is the one sensor branch it needs.
      const applyStep = (step: StepResult<WorldReading>): void => {
        for (const timed of step.readings) {
          if (timed.reading.sensor !== "kiosk") {
            continue;
          }
          mapFlashes.push({
            id: nextFlashId,
            kind: timed.reading.reading.outcome === "fail" ? "pinfail" : "signin",
            node: kioskNodeId(timed.reading.reading.station),
            atTick: timed.tick,
          });
          nextFlashId += 1;
        }
        for (const [id, presence] of step.presences) {
          const view = views.get(id);
          if (view !== undefined) {
            views.set(id, { id: view.id, kind: view.kind, presence });
          }
        }
        for (const id of step.dormant) {
          views.delete(id);
        }
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

      // Tick zero: prime the schedule once at startup, before the clock loop, with
      // advanceTo(1) (NOT advanceTo(0), which emits nothing under the half-open rule).
      // Any ts=0 reading is folded now, matching Part C's note; now() is still 0 here.
      applyStep(schedule.advanceTo(1));
      pruneFlashes();

      // The actor-stepping tick listener, registered FIRST — before the sampler and the
      // checkpoint listener — so this tick's presence is already folded when the sampler
      // publishes and the enqueue would sit ahead of admission (Part C). Each game tick
      // advances the schedule to now()+1 (one integer tick), so a reading emitted on tick
      // T carries atTick T <= nowTick. A throwing actor is a failed outcome, like a task.
      clock.onTick(() => {
        if (stopped) {
          return;
        }
        try {
          const horizon = (clock?.now() ?? 0) + 1;
          applyStep(schedule.advanceTo(horizon));
          mapNowTick = horizon - 1;
          pruneFlashes();
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
        if (queued !== 0) {
          finishOutcome("failed", "queue");
          return;
        }
        if (options.scorer.reading().rolling < CORRECTNESS_FLOOR) {
          finishOutcome("failed", "correctness");
          return;
        }
        if (isFinal) {
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
