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
import { ema, emaAlpha, perSecond } from "../sim/rate";
import type { SimSnapshot } from "../sim/snapshot";
import { runIngest, runSink } from "../sim/tasks";
import { Clock, ClockStoppedError, intervalDriver, type TickDriver } from "./clock";
import {
  CHANNEL_CAP,
  CLOCK_HZ,
  HEAT_COOL_S,
  HEAT_RAMP_S,
  OCC_THRESHOLD,
  PUBLISH_HZ,
  RATE_TAU,
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
 * Build the sampler. It runs every tick but samples once per publish interval
 * (CLOCK_HZ / PUBLISH_HZ ticks), computing per-edge rates and per-node heat from
 * exact per-sample deltas, then publishing one snapshot.
 */
function makeSampler(
  clock: Clock,
  backlog: Channel<Event>,
  chain: LinearChain,
  setSnapshot: (snapshot: SimSnapshot) => void,
): () => void {
  const ticksPerSample = CLOCK_HZ / PUBLISH_HZ;
  const alpha = emaAlpha(RATE_TAU, PUBLISH_HZ);
  const rampStep = 1 / (HEAT_RAMP_S * PUBLISH_HZ);
  const coolStep = 1 / (HEAT_COOL_S * PUBLISH_HZ);

  let lastSampleTick = clock.now();
  let lastAccepted = 0;
  let lastPulled = 0;
  let inRate = 0;
  let outRate = 0;
  let throughput = 0;
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
    throughput = ema(throughput, outSample, alpha);
    lastAccepted = backlog.accepted;
    lastPulled = backlog.pulled;
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
  let backlog: Channel<Event> | null = null;
  let detachVisibility: (() => void) | null = null;
  let stopped = false;

  const stop = (): void => {
    if (stopped) {
      return;
    }
    stopped = true;
    clock?.stop();
    backlog?.close();
    detachVisibility?.();
  };

  const fail = (error: unknown): void => {
    if (isTeardownError(error)) {
      return; // expected during teardown, not a failure
    }
    options.onError?.(error);
    stop();
  };

  try {
    const driver = options.driver ?? intervalDriver(CLOCK_HZ);
    clock = new Clock(CLOCK_HZ, driver);
    backlog = new Channel<Event>(CHANNEL_CAP);
    const bind = options.bindVisibility ?? bindVisibilityDefault;
    detachVisibility = bind(clock);

    const ingestTask = runIngest(backlog, clock, options.getRate, chain.ingestId, CLOCK_HZ).catch(
      fail,
    );
    const sinkTask = runSink(backlog, clock, options.getRate, chain.sinkId, CLOCK_HZ).catch(fail);

    const sample = makeSampler(clock, backlog, chain, options.setSnapshot);
    clock.onTick(() => {
      try {
        sample();
      } catch (error) {
        fail(error);
      }
    });

    const whenStopped = Promise.allSettled([ingestTask, sinkTask]).then(() => undefined);
    return { stop, whenStopped };
  } catch (error) {
    stop(); // partial teardown, so a half-built engine leaks nothing
    throw error;
  }
}
