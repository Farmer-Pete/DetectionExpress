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
