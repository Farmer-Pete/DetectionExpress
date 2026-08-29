/**
 * The engine wires the graph into a running pipeline: a Clock, one channel per
 * edge, a node task per node, a governed Detect, and a sampler that publishes one
 * atomic snapshot at PUBLISH_HZ. It owns a deadline-driven lifecycle: a
 * transactional `start`, checkpoints evaluated at the start-of-tick boundary, a
 * single-stop supervisor, a synchronous idempotent `stop`, and a terminal deferred
 * resolved only at true teardown.
 *
 * The run no longer ends when the stream drains. It ends at a checkpoint: a failed
 * one (Backlog not clear, or Correctness below the floor) or the final deadline (a
 * win when clear). Every game-outcome terminal transition force-publishes the
 * terminal snapshot first, so the HUD always receives the outcome. An explicit
 * stop is a teardown, not an outcome, so it publishes nothing.
 *
 * The Scenario, the loaded Algorithm, the scorer, the Ingest generator, the service
 * rate, and the checkpoints are all injected by the run controller, so `sim/` stays
 * pure and the engine never builds them or reads a sensor field itself.
 */
import { Channel } from "../sim/channel";
import type { Scorer } from "../sim/correctness";
import type { PipeEvent, PipeMessage } from "../sim/event";
import {
  type GraphEdge,
  type GraphNode,
  type LinearChain,
  validateLinearChain,
} from "../sim/graph";
import { nextHeat, occupancy } from "../sim/heat";
import { ema, emaAlpha, makeWindowedRate, perSecond } from "../sim/rate";
import type { Checkpoint } from "../sim/scenario";
import type { ServiceRate } from "../sim/service-governor";
import type { FailureReason, RunStatus, SimSnapshot } from "../sim/snapshot";
import { NODE_TASKS, type NodeRuntime, type NodeWiring, type TaskAlgorithm } from "../sim/tasks";
import { Clock, intervalDriver, type TickDriver } from "./clock";
import {
  CHANNEL_CAP,
  CLOCK_HZ,
  CORRECTNESS_FLOOR,
  GAME_SECONDS_PER_TICK,
  HEAT_COOL_S,
  HEAT_RAMP_S,
  OCC_THRESHOLD,
  PUBLISH_HZ,
  RATE_TAU,
  THROUGHPUT_WINDOW_MS,
} from "./tuning";
import { bindVisibility as bindVisibilityDefault } from "./visibility";

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
  /** Defaults to a real setInterval driver; tests pass a manual one. */
  driver?: TickDriver;
  /** Defaults to the real visibility binding; tests pass a no-op. */
  bindVisibility?: (clock: Clock) => () => void;
  /** Reports an engine or Rule failure. */
  onError?: (error: unknown) => void;
}

/** A running engine. `stop` tears it down; `whenStopped` settles for tests. */
export interface EngineHandle {
  stop: () => void;
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

/** Per-edge smoothing state, kept across samples. */
interface EdgeState {
  lastAccepted: number;
  lastPulled: number;
  inRate: number;
  outRate: number;
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
 * with no ticks elapsed keeps the prior rates and heat, but always refreshes
 * Backlog, Correctness, and the run counters, so the terminal reading cannot drift.
 */
function makeSampler(
  clock: Clock,
  channels: Map<string, Channel<PipeMessage>>,
  chain: LinearChain,
  edges: GraphEdge[],
  scorer: Scorer,
  setSnapshot: (snapshot: SimSnapshot) => void,
  run: RunState,
): (force: boolean) => void {
  const ticksPerSample = CLOCK_HZ / PUBLISH_HZ;
  const alpha = emaAlpha(RATE_TAU, PUBLISH_HZ);
  const rampStep = 1 / (HEAT_RAMP_S * PUBLISH_HZ);
  const coolStep = 1 / (HEAT_COOL_S * PUBLISH_HZ);
  const throughputSamples = Math.round((THROUGHPUT_WINDOW_MS * PUBLISH_HZ) / 1000);
  const throughputRate = makeWindowedRate(throughputSamples, PUBLISH_HZ);

  const edgeState = new Map<string, EdgeState>();
  for (const edgeId of chain.edgeIds) {
    edgeState.set(edgeId, { lastAccepted: 0, lastPulled: 0, inRate: 0, outRate: 0 });
  }
  const nodeHeat = new Map<string, number>();
  const nodeInput = new Map<string, Channel<PipeMessage> | undefined>();
  for (const nodeId of chain.nodeIds) {
    nodeHeat.set(nodeId, 0);
    const inputEdge = edges.find((edge) => edge.target === nodeId);
    nodeInput.set(nodeId, inputEdge ? channels.get(inputEdge.id) : undefined);
  }

  let lastSampleTick = clock.now();
  let lastCompleted = 0;
  let throughput = 0;

  return (force: boolean): void => {
    const now = clock.now();
    const ticks = now - lastSampleTick;
    if (!force && ticks < ticksPerSample) {
      return;
    }

    // With real elapsed ticks, refresh the smoothed rates, heat, and throughput
    // from exact per-sample deltas. A forced publish at zero elapsed ticks skips
    // this and keeps the prior values, adding no extra ramp or cool step.
    if (ticks > 0) {
      for (const edgeId of chain.edgeIds) {
        const channel = channels.get(edgeId);
        const state = edgeState.get(edgeId);
        if (!channel || !state) {
          continue;
        }
        const inSample = perSecond(channel.accepted - state.lastAccepted, ticks, CLOCK_HZ);
        const outSample = perSecond(channel.pulled - state.lastPulled, ticks, CLOCK_HZ);
        state.inRate = ema(state.inRate, inSample, alpha);
        state.outRate = ema(state.outRate, outSample, alpha);
        state.lastAccepted = channel.accepted;
        state.lastPulled = channel.pulled;
      }
      const completedNow = run.getCompleted();
      throughput = throughputRate(completedNow - lastCompleted);
      lastCompleted = completedNow;
      for (const nodeId of chain.nodeIds) {
        const channel = nodeInput.get(nodeId);
        const occ = channel ? occupancy(channel.size, channel.cap) : 0;
        nodeHeat.set(
          nodeId,
          nextHeat(nodeHeat.get(nodeId) ?? 0, occ, OCC_THRESHOLD, rampStep, coolStep),
        );
      }
      lastSampleTick = now;
    }

    // Backlog, Correctness, and the run counters are always fresh, even on a
    // zero-tick forced publish.
    let backlog = 0;
    for (const channel of channels.values()) {
      backlog += channel.size;
    }
    const nodes: Record<string, { heat: number }> = {};
    for (const [nodeId, heat] of nodeHeat) {
      nodes[nodeId] = { heat };
    }
    const edgeReadings: Record<string, { inRate: number; outRate: number }> = {};
    for (const [edgeId, state] of edgeState) {
      edgeReadings[edgeId] = { inRate: state.inRate, outRate: state.outRate };
    }

    setSnapshot({
      backlog,
      throughput,
      nodes,
      edges: edgeReadings,
      correctness: scorer.reading(),
      compute: run.compute,
      status: run.getStatus(),
      failureReason: run.getFailureReason(),
      admitted: run.getAdmitted(),
      completed: run.getCompleted(),
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
  const chain = validateLinearChain(graph.nodes, graph.edges); // throws before allocation

  let clock: Clock | null = null;
  let channels: Map<string, Channel<PipeMessage>> | null = null;
  let detachVisibility: (() => void) | null = null;
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
    teardownStep("visibility detach", () => detachVisibility?.());
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

    const bind = options.bindVisibility ?? bindVisibilityDefault;
    detachVisibility = bind(clock);

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
      chain,
      graph.edges,
      options.scorer,
      options.setSnapshot,
      {
        compute,
        getAdmitted: () => admitted,
        getCompleted: () => completed,
        getStatus: () => status,
        getFailureReason: () => failureReason,
      },
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
        const backlog = admitted - completed;
        const isFinal = nextCheckpoint === checkpoints.length - 1;
        if (backlog !== 0) {
          finishOutcome("failed", "backlog");
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

    return { stop, whenStopped };
  } catch (error) {
    stop(); // partial teardown, so a half-built engine leaks nothing
    throw error;
  }
}
