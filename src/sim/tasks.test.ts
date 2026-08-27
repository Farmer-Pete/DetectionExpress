import { describe, expect, it } from "bun:test";
import { Clock, ClockStoppedError, ManualDriver } from "../game/clock";
import { Channel } from "./channel";
import type { Event } from "./event";
import { NODE_TASKS, type NodeRuntime, runIngest, runSink, type TaskClock } from "./tasks";

const HZ = 60;

/** Drain the microtask queue without a real timer. */
async function flush(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    await Promise.resolve();
  }
}

/** Step the clock one tick at a time, flushing so tasks progress each tick. */
async function step(driver: ManualDriver, ticks: number): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    driver.advance(1);
    await flush();
  }
}

/** Swallow the terminal rejection a task throws when the clock stops. */
function guard(task: Promise<void>): void {
  task.catch(() => undefined);
}

function fixed(rate: number): (nodeId: string) => number {
  return () => rate;
}

describe("runIngest", () => {
  it("produces one Event per arrival gap", async () => {
    const driver = new ManualDriver();
    const clock = new Clock(HZ, driver);
    const out = new Channel<Event>(100);
    guard(runIngest(out, clock, fixed(6), "ingest", HZ)); // gap = round(60/6) = 10 ticks
    await flush();
    expect(out.accepted).toBe(1); // one at the top of the run

    await step(driver, 10);
    expect(out.accepted).toBe(2);
    await step(driver, 10);
    expect(out.accepted).toBe(3);
    clock.stop();
  });
});

describe("runSink", () => {
  it("completes every Event it pulls at its service delay", async () => {
    const driver = new ManualDriver();
    const clock = new Clock(HZ, driver);
    const backlog = new Channel<Event>(100);
    await backlog.push({});
    await backlog.push({});
    let completed = 0;
    guard(
      runSink(backlog, clock, fixed(30), "sink", HZ, () => {
        completed += 1;
      }),
    ); // delay = round(60/30) = 2 ticks
    await flush();
    expect(backlog.pulled).toBe(1); // pulled the first, now sleeping
    expect(completed).toBe(0); // not finished until the delay elapses

    await step(driver, 2);
    expect(backlog.pulled).toBe(2);
    expect(completed).toBe(1); // the first Event finished after its delay
    expect(backlog.size).toBe(0);
    clock.stop();
  });

  it("loses no Event across a normal run", async () => {
    const driver = new ManualDriver();
    const clock = new Clock(HZ, driver);
    const backlog = new Channel<Event>(100);
    let completed = 0;
    guard(runIngest(backlog, clock, fixed(6), "ingest", HZ)); // gap 10
    guard(
      runSink(backlog, clock, fixed(30), "sink", HZ, () => {
        completed += 1;
      }),
    ); // delay 2, faster than arrivals
    await flush();

    await step(driver, 60);
    await step(driver, 5); // let the last in-flight Event finish
    // The Sink keeps up, so everything admitted is pulled and completed. None lost.
    expect(backlog.accepted).toBeGreaterThan(3);
    expect(backlog.pulled).toBe(backlog.accepted);
    expect(completed).toBe(backlog.accepted);
    expect(backlog.size).toBe(0);
    clock.stop();
  });

  it("unwinds cleanly when the clock stops mid-turn", async () => {
    const driver = new ManualDriver();
    const clock = new Clock(HZ, driver);
    const backlog = new Channel<Event>(100);
    let error: unknown = null;
    const task = runSink(backlog, clock, fixed(4), "sink", HZ, () => undefined).catch(
      (e: unknown) => {
        error = e;
      },
    );
    await backlog.push({});
    await step(driver, 1); // pulled, now sleeping
    clock.stop();
    await task;
    expect(error).toBeInstanceOf(ClockStoppedError);
  });
});

describe("pause bound", () => {
  it("finishes at most one turn per task, then holds accepted and completed", async () => {
    const driver = new ManualDriver();
    const clock = new Clock(HZ, driver);
    const backlog = new Channel<Event>(100);
    let completed = 0;
    guard(runIngest(backlog, clock, fixed(6), "ingest", HZ)); // gap 10
    guard(
      runSink(backlog, clock, fixed(6), "sink", HZ, () => {
        completed += 1;
      }),
    ); // delay 10
    await flush();
    await step(driver, 40); // some events produced and processed
    const acceptedBeforePause = backlog.accepted;

    clock.pause();
    await flush(); // allow at most one in-flight turn per task to settle
    const acceptedFrozen = backlog.accepted;
    const pulledFrozen = backlog.pulled;
    const sizeFrozen = backlog.size;
    const completedFrozen = completed;
    expect(acceptedFrozen).toBeLessThanOrEqual(acceptedBeforePause + 1); // at most one more turn

    await step(driver, 200); // paused ticks are absorbed; every counter holds
    expect(backlog.accepted).toBe(acceptedFrozen);
    expect(backlog.pulled).toBe(pulledFrozen); // the Sink pulls nothing while paused
    expect(backlog.size).toBe(sizeFrozen);
    expect(completed).toBe(completedFrozen);

    clock.resume();
    await step(driver, 20);
    expect(backlog.accepted).toBeGreaterThan(acceptedFrozen); // production resumes
    clock.stop();
  });
});

describe("NODE_TASKS registry", () => {
  // The task never touches the clock: it fails on wiring before its first await.
  const idleClock: TaskClock = {
    gate: () => Promise.resolve(),
    sleep: () => Promise.resolve(),
  };
  const runtime: NodeRuntime = {
    clock: idleClock,
    getRate: fixed(6),
    clockHz: HZ,
    onComplete: () => undefined,
  };
  const noWiring = { input: undefined, output: undefined };

  it("registers a task for each known node kind", () => {
    expect(NODE_TASKS.has("ingest")).toBe(true);
    expect(NODE_TASKS.has("sink")).toBe(true);
  });

  it("the Ingest task fails fast without an output channel", () => {
    const task = NODE_TASKS.get("ingest");
    expect(task).toBeDefined();
    if (!task) return;
    expect(() => task("ingest", noWiring, runtime)).toThrow(/output/i);
  });

  it("the Sink task fails fast without an input channel", () => {
    const task = NODE_TASKS.get("sink");
    expect(task).toBeDefined();
    if (!task) return;
    expect(() => task("sink", noWiring, runtime)).toThrow(/input/i);
  });
});
