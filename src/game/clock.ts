/**
 * Clock: the one tick source. It counts ticks (never seconds), so a stall or a
 * throttled tab cannot inflate a delta. Every wait in the engine goes through
 * `sleep` or `gate`, so time, pause, and stop live in one place and no abort
 * code is scattered through the tasks.
 *
 * A TickDriver advances the Clock. The production driver wraps setInterval; a
 * ManualDriver lets a test step time by hand with `advance`, so tests use no
 * real clock.
 */

/** Recognizable rejection for a sleep or gate cut off by a terminal stop. */
export class ClockStoppedError extends Error {
  constructor(message = "clock stopped") {
    super(message);
    this.name = "ClockStoppedError";
  }
}

/** Drives a Clock forward. It calls the tick callback once per tick. */
export interface TickDriver {
  start(onTick: () => void): void;
  stop(): void;
  /** Re-arm the driver at a new wall-clock rate, keeping the same tick callback. */
  setRate(hz: number): void;
}

/** A driver a test steps by hand. `advance(n)` fires n ticks with no real time. */
export class ManualDriver implements TickDriver {
  private onTick: (() => void) | null = null;

  start(onTick: () => void): void {
    this.onTick = onTick;
  }

  stop(): void {
    this.onTick = null;
  }

  /** No-op: tests fire ticks by hand, so a wall-clock rate is meaningless here. */
  setRate(_hz: number): void {}

  /**
   * Fire exactly one tick. Multi-tick stepping is deliberately not offered here:
   * a synchronous burst would starve a re-registering task, whose continuation
   * runs as a microtask between ticks. Bulk stepping goes through a helper that
   * drains those microtasks per tick (the `step` helpers in the task tests).
   */
  tick(): void {
    this.onTick?.();
  }
}

/** The production driver: a fixed-rate setInterval. */
export function intervalDriver(hz: number): TickDriver {
  let handle: ReturnType<typeof setInterval> | null = null;
  let tick: (() => void) | null = null;
  return {
    start(onTick: () => void): void {
      tick = onTick;
      handle = setInterval(onTick, 1000 / hz);
    },
    stop(): void {
      if (handle !== null) {
        clearInterval(handle);
        handle = null;
      }
    },
    setRate(nextHz: number): void {
      // Clear and re-arm at the new period, keeping the same onTick. A driver that
      // has not started, or one already stopped, has nothing to re-arm.
      if (handle === null || tick === null) {
        return;
      }
      clearInterval(handle);
      handle = setInterval(tick, 1000 / nextHz);
    },
  };
}

interface Sleeper {
  dueTick: number;
  resolve: () => void;
  reject: (error: unknown) => void;
}

interface Gate {
  resolve: () => void;
  reject: (error: unknown) => void;
}

export class Clock {
  /** Ticks per second the production driver targets. Kept for fidelity. */
  readonly hz: number;

  private readonly driver: TickDriver;
  private tickCount = 0;
  private paused = false;
  private stopped = false;
  private readonly sleepers: Sleeper[] = [];
  private gates: Gate[] = [];
  private readonly tickListeners: Array<() => void> = [];

  constructor(hz: number, driver: TickDriver) {
    this.hz = hz;
    this.driver = driver;
    try {
      driver.start(() => {
        this.onDriverTick();
      });
    } catch (error) {
      driver.stop(); // undo a partial start, so a failed construction leaks nothing
      throw error;
    }
  }

  /** Monotonic tick count. */
  now(): number {
    return this.tickCount;
  }

  /** Resolves after N active ticks. Rejects at once if already stopped. */
  sleep(ticks: number): Promise<void> {
    if (this.stopped) {
      return Promise.reject(new ClockStoppedError());
    }
    if (ticks <= 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      this.sleepers.push({ dueTick: this.tickCount + ticks, resolve, reject });
    });
  }

  /** Resolves at once while running; holds while paused; rejects if stopped. */
  gate(): Promise<void> {
    if (this.stopped) {
      return Promise.reject(new ClockStoppedError());
    }
    if (!this.paused) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      this.gates.push({ resolve, reject });
    });
  }

  /** Register a per-tick listener. The sampler runs here. */
  onTick(callback: () => void): void {
    this.tickListeners.push(callback);
  }

  /**
   * Change only the driver's wall-clock period. `this.hz` is the fixed base set at
   * construction, so `newHz = baseHz * multiplier` never compounds off the current
   * rate. The tick sequence and now() are unchanged, so per-machine replay holds. It
   * is a no-op after stop, and it never resumes a paused clock: re-arming the driver
   * does not touch the paused flag, so a paused clock stays paused and now() does not
   * advance.
   */
  setSpeed(multiplier: number): void {
    if (!Number.isFinite(multiplier) || multiplier <= 0) {
      throw new Error(`Clock.setSpeed needs a finite positive multiplier, got ${multiplier}.`);
    }
    if (this.stopped) {
      return;
    }
    this.driver.setRate(this.hz * multiplier);
  }

  /** Stop advancing. Sleeps and gates hold until resume or stop. */
  pause(): void {
    if (!this.stopped) {
      this.paused = true;
    }
  }

  /** Advance again and release every held gate. */
  resume(): void {
    if (this.stopped) {
      return;
    }
    this.paused = false;
    const held = this.gates;
    this.gates = [];
    for (const gate of held) {
      gate.resolve();
    }
  }

  /** Terminal: reject every pending and future sleep and gate. */
  stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    // Reject every waiter first, so a throwing driver.stop() can never strand a
    // pending sleep or gate and hang whenStopped.
    const error = new ClockStoppedError();
    for (const sleeper of this.sleepers.splice(0)) {
      sleeper.reject(error);
    }
    const held = this.gates;
    this.gates = [];
    for (const gate of held) {
      gate.reject(error);
    }
    this.driver.stop();
  }

  private onDriverTick(): void {
    if (this.stopped || this.paused) {
      return;
    }
    this.tickCount++;
    const due: Sleeper[] = [];
    for (let i = this.sleepers.length - 1; i >= 0; i--) {
      const sleeper = this.sleepers[i];
      if (sleeper && sleeper.dueTick <= this.tickCount) {
        due.push(sleeper);
        this.sleepers.splice(i, 1);
      }
    }
    for (const sleeper of due) {
      sleeper.resolve();
    }
    for (const listener of this.tickListeners) {
      listener();
    }
  }
}
