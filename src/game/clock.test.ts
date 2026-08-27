import { describe, expect, it } from "bun:test";
import { Clock, ClockStoppedError, ManualDriver, type TickDriver } from "./clock";

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

/**
 * Fire n ticks in a row. These tests check the tick count and single waits, so
 * a synchronous burst is faithful. A test that drives a re-registering task
 * steps one tick at a time and flushes between them instead.
 */
function tickN(driver: ManualDriver, n: number): void {
  for (let i = 0; i < n; i++) {
    driver.tick();
  }
}

describe("Clock", () => {
  it("advances the tick count by hand", () => {
    const { clock, driver } = makeClock();
    expect(clock.now()).toBe(0);
    tickN(driver, 5);
    expect(clock.now()).toBe(5);
  });

  it("resolves a sleep after N active ticks", async () => {
    const { clock, driver } = makeClock();
    let woke = false;
    clock.sleep(3).then(() => {
      woke = true;
    });
    tickN(driver, 2);
    await flush();
    expect(woke).toBe(false);
    tickN(driver, 1);
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
    tickN(driver, 10);
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
    tickN(driver, 4);
    expect(ticks).toBe(4);
    clock.pause();
    tickN(driver, 4);
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
    tickN(driver, 3);
    clock.stop();
    tickN(driver, 3);
    expect(clock.now()).toBe(3);
  });
});

describe("Clock driver resilience", () => {
  it("stops the driver when its start throws, so construction leaks nothing", () => {
    class FailStartDriver implements TickDriver {
      stopped = false;
      start(): void {
        throw new Error("start boom");
      }
      stop(): void {
        this.stopped = true;
      }
    }
    const driver = new FailStartDriver();
    expect(() => new Clock(60, driver)).toThrow(/start boom/);
    expect(driver.stopped).toBe(true); // partial start undone
  });

  it("rejects a pending sleep even when the driver's stop throws", async () => {
    class FailStopDriver implements TickDriver {
      start(): void {
        // no-op: this test never advances
      }
      stop(): void {
        throw new Error("stop boom");
      }
    }
    const clock = new Clock(60, new FailStopDriver());
    let rejection: unknown = null;
    const guarded = clock.sleep(5).catch((error: unknown) => {
      rejection = error;
    });
    expect(() => clock.stop()).toThrow(/stop boom/); // the driver error still surfaces
    await guarded;
    expect(rejection).toBeInstanceOf(ClockStoppedError); // but the waiter settled
  });
});
