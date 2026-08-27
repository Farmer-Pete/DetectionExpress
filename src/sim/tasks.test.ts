import { describe, expect, it } from "bun:test";
import { Clock, ClockStoppedError, ManualDriver } from "../game/clock";
import { Channel } from "./channel";
import type { Event } from "./event";
import { runIngest, runSink } from "./tasks";

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
    guard(runSink(backlog, clock, fixed(30), "sink", HZ)); // delay = round(60/30) = 2 ticks
    await flush();
    expect(backlog.pulled).toBe(1); // pulled the first, now sleeping

    await step(driver, 2);
    expect(backlog.pulled).toBe(2);
    expect(backlog.size).toBe(0);
    clock.stop();
  });

  it("loses no Event across a normal run", async () => {
    const driver = new ManualDriver();
    const clock = new Clock(HZ, driver);
    const backlog = new Channel<Event>(100);
    guard(runIngest(backlog, clock, fixed(6), "ingest", HZ)); // gap 10
    guard(runSink(backlog, clock, fixed(30), "sink", HZ)); // delay 2, faster than arrivals
    await flush();

    await step(driver, 60);
    // The Sink keeps up, so everything admitted has been pulled and nothing is stuck.
    expect(backlog.accepted).toBeGreaterThan(3);
    expect(backlog.pulled).toBe(backlog.accepted);
    expect(backlog.size).toBe(0);
    clock.stop();
  });

  it("unwinds cleanly when the clock stops mid-turn", async () => {
    const driver = new ManualDriver();
    const clock = new Clock(HZ, driver);
    const backlog = new Channel<Event>(100);
    let error: unknown = null;
    const task = runSink(backlog, clock, fixed(4), "sink", HZ).catch((e: unknown) => {
      error = e;
    });
    await backlog.push({});
    await step(driver, 1); // pulled, now sleeping
    clock.stop();
    await task;
    expect(error).toBeInstanceOf(ClockStoppedError);
  });
});

describe("pause bound", () => {
  it("lets each task finish at most one turn, then holds", async () => {
    const driver = new ManualDriver();
    const clock = new Clock(HZ, driver);
    const backlog = new Channel<Event>(100);
    guard(runIngest(backlog, clock, fixed(6), "ingest", HZ)); // gap 10
    await flush();
    await step(driver, 25); // some events produced
    const acceptedAtPause = backlog.accepted;

    clock.pause();
    await step(driver, 200); // paused ticks are absorbed; the count holds
    expect(backlog.accepted).toBe(acceptedAtPause);

    clock.resume();
    await step(driver, 10);
    expect(backlog.accepted).toBe(acceptedAtPause + 1); // production resumes
    clock.stop();
  });
});
