import { describe, expect, it } from "vitest";
import {
  CLOCK_HZ,
  DRAIN_GAP_TICKS,
  INTRO_TICKS,
  PUBLISH_HZ,
  WAVE_COUNT,
  WAVE_DURATION_TICKS,
  WAVE_RATES,
  WAVE_WARN_TICKS,
} from "../game/tuning";
import { admitArrivals } from "./actors/admission";
import { buildSchedule } from "./schedule";

describe("buildSchedule", () => {
  it("emits one wave per rate, half-open and rising, with no overlap", () => {
    const { waves } = buildSchedule();
    expect(waves.length).toBe(WAVE_COUNT);
    expect(WAVE_COUNT).toBe(WAVE_RATES.length);
    expect(waves[0]?.startTick).toBe(INTRO_TICKS); // the intro precedes Wave 1
    let prevEnd = -1;
    let prevRate = -1;
    for (const wave of waves) {
      expect(wave.durationTicks).toBeGreaterThan(0);
      expect(wave.startTick).toBeGreaterThanOrEqual(prevEnd); // [start, end): no overlap
      expect(wave.eventsPerTick).toBeGreaterThan(prevRate); // rates climb wave over wave
      prevEnd = wave.startTick + wave.durationTicks;
      prevRate = wave.eventsPerTick;
    }
  });

  it("puts each checkpoint a drain gap past its wave, in tick order, next wave at/after it", () => {
    const { waves, checkpoints } = buildSchedule();
    expect(checkpoints.length).toBe(waves.length);
    let prevTick = -1;
    checkpoints.forEach((cp, i) => {
      const wave = waves[i];
      expect(wave).toBeDefined();
      if (!wave) return;
      expect(cp.clearsThroughWave).toBe(i);
      expect(cp.atTick).toBe(wave.startTick + wave.durationTicks + DRAIN_GAP_TICKS);
      expect(cp.atTick).toBeGreaterThan(prevTick); // strictly ascending
      const nextWave = waves[i + 1];
      if (nextWave) {
        expect(nextWave.startTick).toBe(cp.atTick); // the next wave starts exactly at the checkpoint
      }
      prevTick = cp.atTick;
    });
  });

  it("matches the exact wave rates from tuning, in order", () => {
    const { waves } = buildSchedule();
    expect(waves.map((w) => w.eventsPerTick)).toEqual([...WAVE_RATES]);
    expect(waves.every((w) => w.durationTicks === WAVE_DURATION_TICKS)).toBe(true);
  });

  it("is deterministic: repeated calls return the same schedule", () => {
    expect(buildSchedule()).toEqual(buildSchedule());
  });

  it("keeps the observable successor-incoming window at or above the publish stride (F012, F023)", () => {
    // The publish stride, CLOCK_HZ / PUBLISH_HZ, is the coarsest sample spacing the
    // sampler ever takes (currently 3 ticks). A successor wave's checkpoint lands
    // exactly DRAIN_GAP_TICKS after the prior wave ends (see the test above), so the
    // gap is an upper bound on the successor's 'incoming' window — but `active`
    // outranks `incoming` (wave-state.ts's precedence note), so the prior wave still
    // reads 'active' until WAVE_WARN_TICKS opens the successor's warn window, which
    // can land later than the gap's own start. The window `waveStateAt` can actually
    // read is therefore min(WAVE_WARN_TICKS, DRAIN_GAP_TICKS) ticks wide, not
    // DRAIN_GAP_TICKS alone. A window smaller than the publish stride can let every
    // publish sample land on either side of it, or shrink it to zero ticks, so the
    // flash/shake/announcement silently never fires for that wave.
    expect(Math.min(WAVE_WARN_TICKS, DRAIN_GAP_TICKS)).toBeGreaterThanOrEqual(
      CLOCK_HZ / PUBLISH_HZ,
    );
  });
});

describe('buildSchedule("steady") (GH124-PLAN.md Checkpoint 3)', () => {
  it("emits WAVE_COUNT contiguous waves at the calm baseline rate", () => {
    const { waves } = buildSchedule("steady");
    expect(waves.length).toBe(WAVE_COUNT);
    expect(waves[0]?.startTick).toBe(INTRO_TICKS);
    let prevEnd = INTRO_TICKS;
    for (const wave of waves) {
      expect(wave.eventsPerTick).toBe(WAVE_RATES[0]);
      expect(wave.durationTicks).toBe(WAVE_DURATION_TICKS);
      expect(wave.startTick).toBe(prevEnd); // gap 0: contiguous, not merely non-overlapping
      prevEnd = wave.startTick + wave.durationTicks;
    }
  });

  it("emits one terminal checkpoint, a drain allowance past the last arrival", () => {
    const { waves, checkpoints } = buildSchedule("steady");
    const lastWave = waves.at(-1);
    expect(checkpoints.length).toBe(1);
    expect(checkpoints[0]?.clearsThroughWave).toBe(WAVE_COUNT - 1);
    expect(checkpoints[0]?.atTick).toBe(
      (lastWave?.startTick ?? 0) + (lastWave?.durationTicks ?? 0) + DRAIN_GAP_TICKS,
    );
  });

  it("does not throw despite gap-0 successors (assertSuccessorGap is mode-gated)", () => {
    const { waves } = buildSchedule("steady");
    expect(() => admitArrivals(waves, "steady")).not.toThrow();
  });

  it("turns into one gapless constant arrival stream: every tick from the first wave's start through the last wave's end admits the baseline rate", () => {
    const { waves } = buildSchedule("steady");
    const arrivals = admitArrivals(waves, "steady");
    const first = waves[0];
    const last = waves.at(-1);
    if (!first || !last) throw new Error("expected at least one steady wave");
    const rate = WAVE_RATES[0] ?? 0;
    const totalTicks = last.startTick + last.durationTicks - first.startTick;
    expect(arrivals.length).toBe(totalTicks * rate);
    for (let tick = first.startTick; tick < first.startTick + totalTicks; tick++) {
      const countAtTick = arrivals.filter((t) => t === tick).length;
      expect(countAtTick).toBe(rate);
    }
  });

  it("still gives planAttacks() a plan-per-wave contract: exactly WAVE_COUNT waves", () => {
    const { waves } = buildSchedule("steady");
    expect(waves.length).toBe(WAVE_COUNT);
  });
});
