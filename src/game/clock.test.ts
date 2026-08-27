import { describe, expect, it } from "bun:test";
import { Clock, ClockStoppedError, ManualDriver } from "./clock";

/** Drain the microtask queue without any real timer. */
async function flush(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    await Promise.resolve();
  }
}

function makeClock(): { clock: Clock; driver: ManualDriver } {
  const driver = new ManualDriver();
  const clock = new Clock(60, driver);
  return { clock, driver };
}

describe("Clock", () => {
  it("advances the tick count by hand", () => {
    const { clock, driver } = makeClock();
    expect(clock.now()).toBe(0);
    driver.advance(5);
    expect(clock.now()).toBe(5);
  });

  it("resolves a sleep after N active ticks", async () => {
    const { clock, driver } = makeClock();
    let woke = false;
    clock.sleep(3).then(() => {
      woke = true;
    });
    driver.advance(2);
    await flush();
    expect(woke).toBe(false);
    driver.advance(1);
    await flush();
    expect(woke).toBe(true);
  });

  it("passes a gate while running", async () => {
    const { clock } = makeClock();
    let passed = false;
    clock.gate().then(() => {
      passed = true;
    });
    await flush();
    expect(passed).toBe(true);
  });

  it("holds gates and sleeps while paused, and does not advance", async () => {
    const { clock, driver } = makeClock();
    clock.pause();
    let passed = false;
    let woke = false;
    clock.gate().then(() => {
      passed = true;
    });
    clock.sleep(1).then(() => {
      woke = true;
    });
    driver.advance(10);
    await flush();
    expect(clock.now()).toBe(0); // paused ticks do not advance the count
    expect(passed).toBe(false);
    expect(woke).toBe(false);
  });

  it("releases held gates on resume", async () => {
    const { clock } = makeClock();
    clock.pause();
    let passed = false;
    clock.gate().then(() => {
      passed = true;
    });
    await flush();
    expect(passed).toBe(false);
    clock.resume();
    await flush();
    expect(passed).toBe(true);
  });

  it("runs tick listeners once per active tick", () => {
    const { clock, driver } = makeClock();
    let ticks = 0;
    clock.onTick(() => {
      ticks++;
    });
    driver.advance(4);
    expect(ticks).toBe(4);
    clock.pause();
    driver.advance(4);
    expect(ticks).toBe(4); // paused: the sampler is skipped
  });

  it("rejects a pending sleep and gate on stop", async () => {
    const { clock } = makeClock();
    clock.pause();
    const gate = clock.gate(); // held while paused
    const sleep = clock.sleep(5); // pending, not yet due
    clock.stop();
    await expect(sleep).rejects.toBeInstanceOf(ClockStoppedError);
    await expect(clock.gate()).rejects.toBeInstanceOf(ClockStoppedError);
    await expect(gate).rejects.toBeInstanceOf(ClockStoppedError);
  });

  it("rejects a sleep or gate started after stop at once", async () => {
    const { clock } = makeClock();
    clock.stop();
    await expect(clock.sleep(1)).rejects.toBeInstanceOf(ClockStoppedError);
    await expect(clock.gate()).rejects.toBeInstanceOf(ClockStoppedError);
  });

  it("stops advancing after stop", () => {
    const { clock, driver } = makeClock();
    driver.advance(3);
    clock.stop();
    driver.advance(3);
    expect(clock.now()).toBe(3);
  });
});
