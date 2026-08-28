/**
 * The engine wires the graph into a running pipeline: a Clock, one channel per
 * edge, a node task per node, and a sampler that publishes one atomic snapshot at
 * PUBLISH_HZ. It owns the lifecycle: a transactional `start`, a single-stop
 * supervisor, a synchronous idempotent `stop`, and a natural-completion
 * continuation that force-publishes the finalized reading and tears down when the
 * stream ends on its own.
 *
 * The Scenario, the loaded Algorithm, the scorer, and the Ingest generator are all
 * injected by the run controller, so `sim/` stays pure and the engine never builds
 * them or reads a sensor field itself.
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
import type { SimSnapshot } from "../sim/snapshot";
import { NODE_TASKS, type NodeRuntime, type NodeWiring, type TaskAlgorithm } from "../sim/tasks";
import { Clock, intervalDriver, type TickDriver } from "./clock";
import {
  CHANNEL_CAP,
  CLOCK_HZ,
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

/**
 * Build the shared snapshot builder. It runs every tick in normal mode (gated on
 * elapsed ticks) and once at a clean end in forced mode. A forced publish with no
 * ticks elapsed keeps the prior rates and heat, but always refreshes the total
 * Backlog and the finalized Correctness, so the final reading cannot drift from a
 * normal one.
 */
function makeSampler(
  clock: Clock,
  channels: Map<string, Channel<PipeMessage>>,
  chain: LinearChain,
  edges: GraphEdge[],
  scorer: Scorer,
  setSnapshot: (snapshot: SimSnapshot) => void,
  getCompleted: () => number,
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
      const completedNow = getCompleted();
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

    // Backlog and Correctness are always fresh, even on a zero-tick forced publish.
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

    setSnapshot({ backlog, throughput, nodes, edges: edgeReadings, correctness: scorer.reading() });
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
  let stopped = false;
  let completed = 0; // Sink completions, sampled for the Throughput gauge

  const stop = (): void => {
    if (stopped) {
      return;
    }
    stopped = true;
    // Each step is independent: a throw in one (a driver that fails to stop, a
    // detach that throws) must not skip the rest of teardown.
    teardownStep("clock.stop", () => clock?.stop());
    if (channels) {
      for (const channel of channels.values()) {
        teardownStep("channel.close", () => channel.close());
      }
    }
    teardownStep("visibility detach", () => detachVisibility?.());
  };

  const fail = (error: unknown): void => {
    // Suppress only once teardown has started. Then the rejected sleeps, gates,
    // pushes, and pulls are expected. Before that, any error is a real failure,
    // even a ClockStoppedError or ChannelClosedError, so tear down and report it.
    if (stopped) {
      return;
    }
    stop(); // tear down first, so a throwing onError cannot leak the engine
    try {
      options.onError?.(error);
    } catch (handlerError) {
      // A reporter that throws is the caller's bug. Log it so teardown still holds.
      console.error("Detection Express onError handler threw:", handlerError);
    }
  };

  try {
    const driver = options.driver ?? intervalDriver(CLOCK_HZ);
    clock = new Clock(CLOCK_HZ, driver);

    // One bounded channel per edge. The chain has three edges: Ingest->Normalize,
    // Normalize->Match, Match->Sink.
    const channelMap = new Map<string, Channel<PipeMessage>>();
    for (const edge of graph.edges) {
      channelMap.set(edge.id, new Channel<PipeMessage>(CHANNEL_CAP));
    }
    channels = channelMap; // publish to the outer scope so stop() can close each

    const bind = options.bindVisibility ?? bindVisibilityDefault;
    detachVisibility = bind(clock);

    const onComplete = (): void => {
      completed += 1;
    };
    const runtime: NodeRuntime = {
      clock,
      onComplete,
      algorithm: options.algorithm,
      scorer: options.scorer,
      nextEvent: options.generator,
    };
    // Spawn one task per node, looked up by kind. Adding a node kind is a new
    // registry entry, not an engine change.
    const tasks = graph.nodes.map((node) => {
      const task = NODE_TASKS.get(node.kind);
      if (!task) {
        throw new Error(`No task is registered for node kind "${node.kind}".`);
      }
      return task(node.id, wiringFor(node.id, graph.edges, channelMap), runtime).catch(fail);
    });

    const publish = makeSampler(
      clock,
      channelMap,
      chain,
      graph.edges,
      options.scorer,
      options.setSnapshot,
      () => completed,
    );
    clock.onTick(() => {
      try {
        publish(false);
      } catch (error) {
        fail(error);
      }
    });

    // Natural completion: when every task returns on its own (a clean end, not a
    // user stop or a task failure), force-publish the finalized snapshot and tear
    // down. A throwing setSnapshot routes through the guarded fail() path, and
    // teardown still runs in the finally, so whenStopped stays resolve-only.
    const whenStopped = Promise.allSettled(tasks).then(() => {
      if (stopped) {
        return;
      }
      try {
        publish(true);
      } catch (error) {
        fail(error);
      } finally {
        stop();
      }
    });
    return { stop, whenStopped };
  } catch (error) {
    stop(); // partial teardown, so a half-built engine leaks nothing
    throw error;
  }
}
