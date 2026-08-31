import { describe, expect, it } from "vitest";
import type { Wave } from "./scenario";
import { assertWaveScheduleOrdered } from "./wave-schedule";

describe("assertWaveScheduleOrdered", () => {
  it("accepts an empty schedule", () => {
    expect(() => assertWaveScheduleOrdered([])).not.toThrow();
  });

  it("accepts waves in ascending startTick order", () => {
    const waves: Wave[] = [
      { startTick: 0, durationTicks: 5, eventsPerTick: 1 },
      { startTick: 10, durationTicks: 5, eventsPerTick: 2 },
      { startTick: 20, durationTicks: 5, eventsPerTick: 3 },
    ];
    expect(() => assertWaveScheduleOrdered(waves)).not.toThrow();
  });

  it("accepts touching boundaries, where one wave's end equals the next wave's start", () => {
    const waves: Wave[] = [
      { startTick: 0, durationTicks: 10, eventsPerTick: 1 },
      { startTick: 10, durationTicks: 5, eventsPerTick: 2 },
    ];
    expect(() => assertWaveScheduleOrdered(waves)).not.toThrow();
  });

  it("rejects waves given out of chronological order", () => {
    const waves: Wave[] = [
      { startTick: 20, durationTicks: 5, eventsPerTick: 1 },
      { startTick: 0, durationTicks: 5, eventsPerTick: 1 },
    ];
    expect(() => assertWaveScheduleOrdered(waves)).toThrow();
  });

  it("rejects two waves that overlap", () => {
    const waves: Wave[] = [
      { startTick: 0, durationTicks: 10, eventsPerTick: 1 },
      { startTick: 5, durationTicks: 10, eventsPerTick: 1 },
    ];
    expect(() => assertWaveScheduleOrdered(waves)).toThrow();
  });

  it("rejects overlapping waves given out of order", () => {
    const waves: Wave[] = [
      { startTick: 5, durationTicks: 10, eventsPerTick: 1 },
      { startTick: 0, durationTicks: 10, eventsPerTick: 1 },
    ];
    expect(() => assertWaveScheduleOrdered(waves)).toThrow();
  });
});
