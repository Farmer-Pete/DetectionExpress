import { randomLcg } from "d3-random";
import { describe, expect, it } from "vitest";
import {
  ATTACKS_PER_WAVE,
  GAME_SECONDS_PER_TICK,
  PIN_BRUTE_FORCE_THRESHOLD,
  PIN_BRUTE_FORCE_WINDOW_S,
  WAVE_RATES,
} from "../../../game/tuning";
import { buildSchedule } from "../../schedule";
import { attackFromPlan, planAttacks, selectVictims } from "./attacks";

/** The total attackers across all waves. */
const VICTIM_COUNT = ATTACKS_PER_WAVE.reduce((sum, n) => sum + n, 0);

/** A distinct victim pool large enough for the total burst count. */
function pool(size: number): string[] {
  return Array.from({ length: size }, (_v, i) => `acct.${i}`);
}

describe("ATTACKS_PER_WAVE", () => {
  it("has one entry per wave rate", () => {
    expect(ATTACKS_PER_WAVE.length).toBe(WAVE_RATES.length);
  });
});

describe("selectVictims", () => {
  it("draws the requested count of globally distinct accounts", () => {
    const victims = selectVictims(pool(40), randomLcg(7), VICTIM_COUNT);
    expect(victims).toHaveLength(VICTIM_COUNT);
    expect(new Set(victims).size).toBe(VICTIM_COUNT);
  });

  it("is deterministic for a seed", () => {
    const a = selectVictims(pool(40), randomLcg(7), VICTIM_COUNT);
    const b = selectVictims(pool(40), randomLcg(7), VICTIM_COUNT);
    expect(a).toEqual(b);
  });
});

describe("planAttacks", () => {
  it("throws when ATTACKS_PER_WAVE does not match the wave count", () => {
    const waves = buildSchedule().waves.slice(0, WAVE_RATES.length - 1);
    const victims = selectVictims(pool(40), randomLcg(7), VICTIM_COUNT);
    expect(() => planAttacks(waves, victims, randomLcg(7))).toThrow(/ATTACKS_PER_WAVE/);
  });

  it("plans exactly the total burst count on globally distinct victims, ids 1..N", () => {
    const { waves } = buildSchedule();
    const victims = selectVictims(pool(40), randomLcg(7), VICTIM_COUNT);
    const plans = planAttacks(waves, victims, randomLcg(7));
    expect(plans).toHaveLength(VICTIM_COUNT);
    expect(new Set(plans.map((p) => p.account)).size).toBe(VICTIM_COUNT);
    expect(plans.map((p) => p.id)).toEqual(Array.from({ length: VICTIM_COUNT }, (_v, i) => i + 1));
  });

  it("carries exactly its count per wave, each burst inside its wave, window, and one detection window", () => {
    const { waves } = buildSchedule();
    const victims = selectVictims(pool(40), randomLcg(11), VICTIM_COUNT);
    const plans = planAttacks(waves, victims, randomLcg(11));

    let planIndex = 0;
    waves.forEach((wave, waveIndex) => {
      const count = ATTACKS_PER_WAVE[waveIndex] ?? 0;
      const waveStartTs = wave.startTick * GAME_SECONDS_PER_TICK;
      const waveEndTs = (wave.startTick + wave.durationTicks) * GAME_SECONDS_PER_TICK;
      for (let b = 0; b < count; b++) {
        const plan = plans[planIndex];
        planIndex += 1;
        expect(plan).toBeDefined();
        if (!plan) {
          continue;
        }
        expect(plan.failTimestamps.length).toBeGreaterThanOrEqual(PIN_BRUTE_FORCE_THRESHOLD);
        // Every fail falls inside the wave and inside the plan's own window.
        for (const ts of plan.failTimestamps) {
          expect(ts).toBeGreaterThanOrEqual(waveStartTs);
          expect(ts).toBeLessThanOrEqual(waveEndTs);
          expect(ts).toBeGreaterThanOrEqual(plan.window.startTs);
          expect(ts).toBeLessThanOrEqual(plan.window.endTs);
        }
        // The whole burst fits inside one detection window, so the rule can catch it.
        expect(plan.window.endTs - plan.window.startTs).toBeLessThan(PIN_BRUTE_FORCE_WINDOW_S);
        // The stagger keeps the start inside [wave + 20, wave + 90] ticks.
        const startTick = plan.window.startTs / GAME_SECONDS_PER_TICK;
        expect(startTick).toBeGreaterThanOrEqual(wave.startTick + 20);
        expect(startTick).toBeLessThanOrEqual(wave.startTick + 90);
      }
    });
    expect(planIndex).toBe(VICTIM_COUNT);
  });
});

// GH42-PLAN.md "Scoring for mixed hunts": the scorer now reads a per-Attack
// threshold, so `attackFromPlan` must set it from this hunt's own tuning.
describe("attackFromPlan", () => {
  it("carries this hunt's threshold on the Attack ground truth", () => {
    const { waves } = buildSchedule();
    const victims = selectVictims(pool(40), randomLcg(7), VICTIM_COUNT);
    const plans = planAttacks(waves, victims, randomLcg(7));
    const plan = plans[0];
    expect(plan).toBeDefined();
    if (!plan) {
      return;
    }
    const attack = attackFromPlan(plan, [1, 2, 3]);
    expect(attack.threshold).toBe(PIN_BRUTE_FORCE_THRESHOLD);
  });
});
