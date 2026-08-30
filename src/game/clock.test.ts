import { describe, expect, it, vi } from "vitest";
import { Clock, ClockStoppedError, intervalDriver, ManualDriver, type TickDriver } from "./clock";

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

describe("Clock speed control", () => {
  /** A driver that records every rate it is armed at, so setSpeed is observable. */
  class RateSpyDriver implements TickDriver {
    rates: number[] = [];
    private onTick: (() => void) | null = null;
    start(onTick: () => void): void {
      this.onTick = onTick;
    }
    stop(): void {
      this.onTick = null;
    }
    setRate(hz: number): void {
      this.rates.push(hz);
    }
    tick(): void {
      this.onTick?.();
    }
  }

  it("re-arms the driver at baseHz * multiplier", () => {
    const driver = new RateSpyDriver();
    const clock = new Clock(60, driver);
    clock.setSpeed(2);
    clock.setSpeed(0.5);
    // The base is fixed at 60, so the second call does not compound off the first
    // (0.5 gives 30, not 60 * 2 * 0.5).
    expect(driver.rates).toEqual([120, 30]);
  });

  it("does not change the tick count or now() when the speed changes", () => {
    const { clock, driver } = makeClock();
    tickN(driver, 3);
    clock.setSpeed(2);
    tickN(driver, 2);
    // ManualDriver.setRate is a no-op, so the by-hand ticks still advance one each.
    expect(clock.now()).toBe(5);
  });

  it("rejects a zero, negative, or non-finite multiplier", () => {
    const { clock } = makeClock();
    expect(() => clock.setSpeed(0)).toThrow();
    expect(() => clock.setSpeed(-1)).toThrow();
    expect(() => clock.setSpeed(Number.POSITIVE_INFINITY)).toThrow();
    expect(() => clock.setSpeed(Number.NaN)).toThrow();
  });

  it("is a no-op after stop", () => {
    const driver = new RateSpyDriver();
    const clock = new Clock(60, driver);
    clock.stop();
    clock.setSpeed(2);
    expect(driver.rates).toEqual([]); // stopped: the driver was never re-armed
  });

  it("does not resume a paused clock", async () => {
    const { clock, driver } = makeClock();
    clock.pause();
    let passed = false;
    clock.gate().then(() => {
      passed = true;
    });
    clock.setSpeed(2); // must not clear the paused flag
    tickN(driver, 5);
    await flush();
    expect(clock.now()).toBe(0); // still paused: no advance
    expect(passed).toBe(false); // the held gate stays held
  });

  it("treats ManualDriver.setRate as a no-op", () => {
    const driver = new ManualDriver();
    const clock = new Clock(60, driver);
    driver.setRate(999);
    clock.setSpeed(2); // routes through the no-op setRate
    tickN(driver, 4);
    expect(clock.now()).toBe(4); // ticks still fire by hand, unaffected
  });
});

describe("intervalDriver setRate", () => {
  it("re-arms at the new period on the same callback, clearing the old interval so no tick double-fires", () => {
    vi.useFakeTimers();
    try {
      const driver = intervalDriver(10); // a 100ms period
      let ticks = 0;
      driver.start(() => {
        ticks += 1;
      });
      vi.advanceTimersByTime(100);
      expect(ticks).toBe(1); // one tick at the original 100ms period

      driver.setRate(4); // a 250ms period, same callback; the old 100ms interval is cleared
      ticks = 0;
      vi.advanceTimersByTime(240);
      expect(ticks).toBe(0); // the old 100ms interval is gone: no stray tick before 250ms
      vi.advanceTimersByTime(10);
      expect(ticks).toBe(1); // the first tick at the new 250ms period
      vi.advanceTimersByTime(250);
      expect(ticks).toBe(2); // exactly one tick per new period, no double-fire
      driver.stop();
    } finally {
      vi.useRealTimers();
    }
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
      setRate(): void {}
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
      setRate(): void {}
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
