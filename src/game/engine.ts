/**
 * The engine wires the graph into a running pipeline: a Clock, one channel per
 * edge, a node task per node, and a sampler that publishes one atomic snapshot
 * at PUBLISH_HZ. It owns the lifecycle: a transactional `start`, a single-stop
 * supervisor, and a synchronous idempotent `stop`.
 */
import { Channel, ChannelClosedError } from "../sim/channel";
import type { Event } from "../sim/event";
import {
  type GraphEdge,
  type GraphNode,
  type LinearChain,
  validateLinearChain,
} from "../sim/graph";
import { nextHeat, occupancy } from "../sim/heat";
import { ema, emaAlpha, makeWindowedRate, perSecond } from "../sim/rate";
import type { SimSnapshot } from "../sim/snapshot";
import { NODE_TASKS, type NodeRuntime, type NodeWiring } from "../sim/tasks";
import { Clock, ClockStoppedError, intervalDriver, type TickDriver } from "./clock";
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
  getRate: (nodeId: string) => number;
  setSnapshot: (snapshot: SimSnapshot) => void;
  /** Defaults to a real setInterval driver; tests pass a manual one. */
  driver?: TickDriver;
  /** Defaults to the real visibility binding; tests pass a no-op. */
  bindVisibility?: (clock: Clock) => () => void;
  /** Reports an unexpected engine failure. */
  onError?: (error: unknown) => void;
}

/** A running engine. `stop` tears it down; `whenStopped` settles for tests. */
export interface EngineHandle {
  stop: () => void;
  whenStopped: Promise<void>;
}

/** Errors expected during teardown. They are not failures. */
function isTeardownError(error: unknown): boolean {
  return error instanceof ClockStoppedError || error instanceof ChannelClosedError;
}

/**
 * A node's wiring, read off the edges: the edge it targets is its input, the
 * edge it sources is its output. The linear chain has one edge, so the Ingest
 * gets an output and the Sink gets an input.
 */
function wiringFor(
  nodeId: string,
  edges: GraphEdge[],
  channels: Map<string, Channel<Event>>,
): NodeWiring {
  let input: Channel<Event> | undefined;
  let output: Channel<Event> | undefined;
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

/**
 * Build the sampler. It runs every tick but samples once per publish interval
 * (CLOCK_HZ / PUBLISH_HZ ticks), computing per-edge rates and per-node heat from
 * exact per-sample deltas, then publishing one snapshot.
 */
function makeSampler(
  clock: Clock,
  backlog: Channel<Event>,
  chain: LinearChain,
  setSnapshot: (snapshot: SimSnapshot) => void,
  getCompleted: () => number,
): () => void {
  const ticksPerSample = CLOCK_HZ / PUBLISH_HZ;
  const alpha = emaAlpha(RATE_TAU, PUBLISH_HZ);
  const rampStep = 1 / (HEAT_RAMP_S * PUBLISH_HZ);
  const coolStep = 1 / (HEAT_COOL_S * PUBLISH_HZ);
  const throughputSamples = Math.round((THROUGHPUT_WINDOW_MS * PUBLISH_HZ) / 1000);
  const throughputRate = makeWindowedRate(throughputSamples, PUBLISH_HZ);

  let lastSampleTick = clock.now();
  let lastAccepted = 0;
  let lastPulled = 0;
  let lastCompleted = 0;
  let inRate = 0;
  let outRate = 0;
  let ingestHeat = 0;
  let sinkHeat = 0;

  return () => {
    const now = clock.now();
    const ticks = now - lastSampleTick;
    if (ticks < ticksPerSample) {
      return;
    }

    const inSample = perSecond(backlog.accepted - lastAccepted, ticks, CLOCK_HZ);
    const outSample = perSecond(backlog.pulled - lastPulled, ticks, CLOCK_HZ);
    inRate = ema(inRate, inSample, alpha);
    outRate = ema(outRate, outSample, alpha);
    // Throughput is a rolling average of Sink completions, so the gauge is
    // steady and readable, not the jittery per-sample rate.
    const completedNow = getCompleted();
    const throughput = throughputRate(completedNow - lastCompleted);
    lastAccepted = backlog.accepted;
    lastPulled = backlog.pulled;
    lastCompleted = completedNow;
    lastSampleTick = now;

    // The Sink's input is the Backlog; the Ingest is a source with no input.
    sinkHeat = nextHeat(
      sinkHeat,
      occupancy(backlog.size, backlog.cap),
      OCC_THRESHOLD,
      rampStep,
      coolStep,
    );
    ingestHeat = nextHeat(ingestHeat, 0, OCC_THRESHOLD, rampStep, coolStep);

    setSnapshot({
      backlog: backlog.size,
      throughput,
      nodes: {
        [chain.ingestId]: { heat: ingestHeat },
        [chain.sinkId]: { heat: sinkHeat },
      },
      edges: {
        [chain.edgeId]: { inRate, outRate },
      },
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
  let channels: Map<string, Channel<Event>> | null = null;
  let detachVisibility: (() => void) | null = null;
  let stopped = false;
  let completed = 0; // Sink completions, sampled for the Throughput gauge

  const stop = (): void => {
    if (stopped) {
      return;
    }
    stopped = true;
    // Each step is independent: a throw in one (a driver that fails to stop)
    // must not skip closing the channels or detaching visibility.
    try {
      clock?.stop();
    } catch (error) {
      console.error("Detection Dash: clock.stop() threw during teardown:", error);
    }
    if (channels) {
      for (const channel of channels.values()) {
        channel.close();
      }
    }
    detachVisibility?.();
  };

  const fail = (error: unknown): void => {
    // Expected teardown errors are not failures. Once we are stopping, a second
    // failure must not re-report or re-run teardown.
    if (isTeardownError(error) || stopped) {
      return;
    }
    stop(); // tear down first, so a throwing onError cannot leak the engine
    try {
      options.onError?.(error);
    } catch (handlerError) {
      // A reporter that throws is the caller's bug. Log it so teardown still holds.
      console.error("Detection Dash onError handler threw:", handlerError);
    }
  };

  try {
    const driver = options.driver ?? intervalDriver(CLOCK_HZ);
    clock = new Clock(CLOCK_HZ, driver);

    // One bounded channel per edge. The linear chain has a single edge, so this
    // builds the one Backlog channel between the Ingest and the Sink.
    const channelMap = new Map<string, Channel<Event>>();
    for (const edge of graph.edges) {
      channelMap.set(edge.id, new Channel<Event>(CHANNEL_CAP));
    }
    channels = channelMap; // publish to the outer scope so stop() can close each
    const backlog = channelMap.get(chain.edgeId);
    if (!backlog) {
      throw new Error(`No channel was built for edge "${chain.edgeId}".`);
    }

    const bind = options.bindVisibility ?? bindVisibilityDefault;
    detachVisibility = bind(clock);

    const onComplete = (): void => {
      completed += 1;
    };
    const runtime: NodeRuntime = {
      clock,
      getRate: options.getRate,
      clockHz: CLOCK_HZ,
      onComplete,
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

    const sample = makeSampler(clock, backlog, chain, options.setSnapshot, () => completed);
    clock.onTick(() => {
      try {
        sample();
      } catch (error) {
        fail(error);
      }
    });

    const whenStopped = Promise.allSettled(tasks).then(() => undefined);
    return { stop, whenStopped };
  } catch (error) {
    stop(); // partial teardown, so a half-built engine leaks nothing
    throw error;
  }
}
