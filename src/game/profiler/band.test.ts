import { describe, expect, it } from "vitest";
import type { Checkpoint } from "../../sim/scenario";
import type { ServiceRate } from "../../sim/service-governor";
import { simulate } from "./band";

/** A fast, integral service rate: `n` records per tick. */
function rate(n: number): ServiceRate {
  return { num: n, den: 1 };
}

describe("simulate: generic checkpoint squeeze", () => {
  it("wins when the service rate clears the queue before every checkpoint", () => {
    // 5 arrivals over ticks 1..5, one checkpoint at tick 6 clearing them.
    const checkpoints: Checkpoint[] = [{ atTick: 6, clearsThroughWave: 0 }];
    const arrivalsByTick = [0, 1, 1, 1, 1, 1];
    const result = simulate({
      arrivalsByTick,
      serviceRate: rate(10),
      channelCap: 100,
      checkpoints,
    });
    expect(result.outcome).toBe("won");
    expect(result.failedCheckpoint).toBe(-1);
    expect(result.queueAtFailure).toBe(0);
  });

  it("fails a checkpoint with a nonzero queue when the service rate is too slow", () => {
    // 100 arrivals in one tick, one checkpoint at tick 2. A rate of 1/tick cannot
    // possibly drain 100 events in one tick.
    const checkpoints: Checkpoint[] = [{ atTick: 2, clearsThroughWave: 0 }];
    const arrivalsByTick = [0, 100];
    const result = simulate({
      arrivalsByTick,
      serviceRate: rate(1),
      channelCap: 1000,
      checkpoints,
    });
    expect(result.outcome).toBe("failed");
    expect(result.failedCheckpoint).toBe(0);
    expect(result.queueAtFailure).toBeGreaterThan(0);
  });

  it("clears an earlier checkpoint but fails a later one", () => {
    const checkpoints: Checkpoint[] = [
      { atTick: 3, clearsThroughWave: 0 },
      { atTick: 5, clearsThroughWave: 1 },
    ];
    // Wave 1: 2 arrivals over ticks 1..2, cleared by a fast rate before tick 3.
    // Wave 2: a burst of 50 at tick 4, too much for tick 4 alone to drain before tick 5.
    const arrivalsByTick = [0, 1, 1, 0, 50];
    const result = simulate({
      arrivalsByTick,
      serviceRate: rate(2),
      channelCap: 1000,
      checkpoints,
    });
    expect(result.outcome).toBe("failed");
    expect(result.failedCheckpoint).toBe(1);
  });

  it("reports -1 and the -1 sentinel failedCheckpoint only on a win", () => {
    const checkpoints: Checkpoint[] = [{ atTick: 2, clearsThroughWave: 0 }];
    const result = simulate({
      arrivalsByTick: [0, 1],
      serviceRate: rate(5),
      channelCap: 10,
      checkpoints,
    });
    expect(result.outcome).toBe("won");
    expect(result.failedCheckpoint).toBe(-1);
  });

  it("tracks maxQueue across the whole run, not just at failure", () => {
    const checkpoints: Checkpoint[] = [{ atTick: 4, clearsThroughWave: 0 }];
    const arrivalsByTick = [0, 3, 0, 0];
    const result = simulate({
      arrivalsByTick,
      serviceRate: rate(1), // drains one per tick: queue peaks at 3, then falls
      channelCap: 100,
      checkpoints,
    });
    expect(result.maxQueue).toBeGreaterThanOrEqual(2);
  });

  it("wins trivially with no arrivals and no queue ever", () => {
    const checkpoints: Checkpoint[] = [{ atTick: 3, clearsThroughWave: 0 }];
    const result = simulate({
      arrivalsByTick: [],
      serviceRate: rate(1),
      channelCap: 10,
      checkpoints,
    });
    expect(result.outcome).toBe("won");
    expect(result.maxQueue).toBe(0);
    expect(result.queueAtFailure).toBe(0);
  });

  it("clamps admission at the backpressure ceiling of 2 * channelCap", () => {
    // A huge burst arrives at once, but only a small channelCap. The channel cap
    // should hold admission back rather than let it run unbounded, so a small
    // service rate can still keep the queue under control long enough to win
    // once arrivals stop and the ceiling drains.
    const checkpoints: Checkpoint[] = [{ atTick: 3, clearsThroughWave: 0 }];
    const arrivalsByTick = [0, 1000];
    const result = simulate({
      arrivalsByTick,
      serviceRate: rate(1000),
      channelCap: 5,
      checkpoints,
    });
    // Admission never exceeds completed + 2*channelCap, so maxQueue is bounded
    // by the ceiling even though 1000 arrived in one tick.
    expect(result.maxQueue).toBeLessThanOrEqual(2 * 5);
  });
});
