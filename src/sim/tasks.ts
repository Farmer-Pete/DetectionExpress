/**
 * Node task logic. Each node is an independent async loop. Each turn it passes
 * the Clock gate, moves one Event over its channel, and waits on the Clock. So a
 * pause holds every task at its next turn, and a stop unwinds it through a
 * rejected wait. No abort code lives here.
 *
 * The tasks depend only on a minimal clock contract, so `sim/` never imports the
 * concrete Clock from `game/`.
 */
import type { Channel } from "./channel";
import { type Event, makeEvent } from "./event";

/** The slice of the Clock a task needs. The concrete Clock satisfies it. */
export interface TaskClock {
  gate(): Promise<void>;
  sleep(ticks: number): Promise<void>;
}

/** Reads a node's current rate (events/sec). Injected by the engine. */
export type GetRate = (nodeId: string) => number;

/**
 * The Ingest task: the source. Each turn it passes the gate, makes an Event,
 * pushes it into the Backlog, then sleeps one arrival gap. A full Backlog blocks
 * the push, so Ingest slows to the Sink's rate. Nothing is dropped.
 */
export async function runIngest(
  out: Channel<Event>,
  clock: TaskClock,
  getRate: GetRate,
  nodeId: string,
  clockHz: number,
): Promise<void> {
  for (;;) {
    await clock.gate();
    await out.push(makeEvent());
    const gap = Math.round(clockHz / getRate(nodeId));
    await clock.sleep(gap);
  }
}

/**
 * The Sink task: the drain. Each turn it passes the gate, pulls one Event from
 * the Backlog, sleeps a per-Event delay, then completes. A long delay lets the
 * Backlog fill.
 */
export async function runSink(
  input: Channel<Event>,
  clock: TaskClock,
  getRate: GetRate,
  nodeId: string,
  clockHz: number,
  onComplete: () => void,
): Promise<void> {
  for (;;) {
    await clock.gate();
    await input.pull();
    const delay = Math.round(clockHz / getRate(nodeId));
    // Part 0 scaffolding: this per-Event sleep fakes a slow node. Part 1 gives
    // players real node code and removes it.
    await clock.sleep(delay);
    onComplete(); // the Event is now processed; drives the Throughput gauge
  }
}

/**
 * A node's channels: the edge it targets is its `input`, the edge it sources is
 * its `output`. A source has no input; a sink has no output.
 */
export interface NodeWiring {
  input: Channel<Event> | undefined;
  output: Channel<Event> | undefined;
}

/** The shared runtime a node task needs, apart from its own wiring. */
export interface NodeRuntime {
  clock: TaskClock;
  getRate: GetRate;
  clockHz: number;
  /** Called each time a node finishes an Event. Drives the Throughput gauge. */
  onComplete: () => void;
}

/**
 * A node task: given a node's id, wiring, and runtime, run its loop until the
 * Clock stops. The engine looks one up by node kind, so it never names a task
 * directly.
 */
export type NodeTask = (nodeId: string, wiring: NodeWiring, runtime: NodeRuntime) => Promise<void>;

/** Resolve a required channel or fail loudly. A missing one is a wiring bug. */
function requireChannel(
  channel: Channel<Event> | undefined,
  nodeId: string,
  role: string,
): Channel<Event> {
  if (!channel) {
    throw new Error(`Node "${nodeId}" needs ${role} wiring, but none was built for it.`);
  }
  return channel;
}

/** The Ingest kind's task: produce into its output edge. */
const ingestTask: NodeTask = (nodeId, wiring, runtime) =>
  runIngest(
    requireChannel(wiring.output, nodeId, "output"),
    runtime.clock,
    runtime.getRate,
    nodeId,
    runtime.clockHz,
  );

/** The Sink kind's task: drain its input edge. */
const sinkTask: NodeTask = (nodeId, wiring, runtime) =>
  runSink(
    requireChannel(wiring.input, nodeId, "input"),
    runtime.clock,
    runtime.getRate,
    nodeId,
    runtime.clockHz,
    runtime.onComplete,
  );

/**
 * The node-kind registry: kind -> task. The engine spawns one task per graph
 * node by its kind, so a later slice adds a node kind by adding one entry here,
 * with no engine change.
 */
export const NODE_TASKS = new Map<string, NodeTask>([
  ["ingest", ingestTask],
  ["sink", sinkTask],
]);
