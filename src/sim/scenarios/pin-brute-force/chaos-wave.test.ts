import { randomLcg } from "d3-random";
import { describe, expect, it } from "vitest";
import { GAME_SECONDS_PER_TICK } from "../../../game/tuning";
import { ATTACK_ACCOUNT_NAMESPACE, BENIGN_ACCOUNT_NAMESPACE } from "../../actors/account-namespace";
import { createSchedule } from "../../actors/actor";
import type { AccountKioskReading } from "../../endpoints/kiosk/internal";
import { distanceTable } from "../../world/distance";
import { buildTimetable } from "../../world/timetable";
import { world } from "../../world/world";
import type { WorldEnv, WorldReading } from "../../world-reading";
import {
  CHAOS_WAVE_MARGIN_TICKS,
  CHAOS_WAVE_MAX_ATTACKERS,
  CHAOS_WAVE_MIN_ATTACKERS,
  type ChaosWaveAttacker,
  planChaosWave,
} from "./chaos-wave";
import { PIN_BRUTE_FORCE_THRESHOLD } from "./tuning";

const env: WorldEnv = {
  world,
  distances: distanceTable(world),
  timetable: buildTimetable(world),
};

/** Name each planned attacker by its index, the way the engine's WaveId scheme does. */
const idFor = (index: number): string => `chaos-attacker-${index}`;

/** A kiosk payload, narrowed off the discriminated union. */
function kioskOf(reading: WorldReading): AccountKioskReading {
  if (reading.sensor !== "kiosk") {
    throw new Error(`expected a kiosk reading, got "${reading.sensor}".`);
  }
  return reading.reading;
}

/**
 * Run one planned attacker straight to just past the shared window's close,
 * collecting its kiosk fails. One `advanceTo` call suffices: the scheduler pops
 * every due actor below the horizon in one pass.
 */
function runAttacker(planned: ChaosWaveAttacker, window: { endTs: number }): AccountKioskReading[] {
  const schedule = createSchedule({ actors: [planned.attacker.build()], env, runSeed: 1 });
  const horizon = window.endTs / GAME_SECONDS_PER_TICK + 5;
  const step = schedule.advanceTo(horizon);
  return step.readings.map((timed) => kioskOf(timed.reading));
}

// GH126-PLAN.md M2a seam 14 (Codex N4), revised: the chaos-wave seam mints a RANDOM
// 2 to 8 attackers, each on a distinct victim from the attack namespace, each its own
// fail burst at or above threshold, all sharing one detection window, independent of
// `planAttacks`'s three-wave escalation.
describe("planChaosWave", () => {
  it("mints between the min and max attackers, inclusive, across many seeds", () => {
    for (let seed = 0; seed < 200; seed++) {
      const plan = planChaosWave(1000, idFor, randomLcg(seed));
      expect(plan.attackers.length).toBeGreaterThanOrEqual(CHAOS_WAVE_MIN_ATTACKERS);
      expect(plan.attackers.length).toBeLessThanOrEqual(CHAOS_WAVE_MAX_ATTACKERS);
    }
    expect(CHAOS_WAVE_MIN_ATTACKERS).toBe(2);
    expect(CHAOS_WAVE_MAX_ATTACKERS).toBe(8);
  });

  it("maps the count draw to both extremes of the inclusive range", () => {
    // A stub rng whose FIRST draw picks the count, then falls back to a real sequence
    // for the victim and per-attacker draws. The lowest draw yields the min, the
    // highest the max, so the range is closed at both ends.
    const withFirst = (first: number): (() => number) => {
      const rest = randomLcg(11);
      let used = false;
      return () => {
        if (!used) {
          used = true;
          return first;
        }
        return rest();
      };
    };
    expect(planChaosWave(1000, idFor, withFirst(0)).attackers.length).toBe(
      CHAOS_WAVE_MIN_ATTACKERS,
    );
    expect(planChaosWave(1000, idFor, withFirst(0.999999)).attackers.length).toBe(
      CHAOS_WAVE_MAX_ATTACKERS,
    );
  });

  it("draws distinct victims, all from the attack namespace, none benign", () => {
    const plan = planChaosWave(1000, idFor, randomLcg(7));
    const victims = plan.attackers.map((a) => a.victim);
    expect(new Set(victims).size).toBe(victims.length); // distinct
    for (const victim of victims) {
      expect(ATTACK_ACCOUNT_NAMESPACE).toContain(victim);
      expect(BENIGN_ACCOUNT_NAMESPACE).not.toContain(victim);
    }
  });

  it("names each attacker through the actorIdFor callback, with distinct ids", () => {
    const plan = planChaosWave(1000, idFor, randomLcg(7));
    const ids = plan.attackers.map((a) => a.actorId);
    expect(new Set(ids).size).toBe(ids.length); // distinct
    plan.attackers.forEach((planned, index) => {
      expect(planned.actorId).toBe(idFor(index));
    });
  });

  it("gives every attacker a fail burst at or above threshold, matching its evidence count", () => {
    const plan = planChaosWave(1000, idFor, randomLcg(7));
    expect(plan.threshold).toBe(PIN_BRUTE_FORCE_THRESHOLD);
    for (const planned of plan.attackers) {
      expect(planned.attacker.kind).toBe("pin-attacker");
      expect(planned.evidenceCount).toBeGreaterThanOrEqual(PIN_BRUTE_FORCE_THRESHOLD);
      const fails = runAttacker(planned, plan.window);
      expect(fails.length).toBe(planned.evidenceCount);
      expect(fails.length).toBeGreaterThanOrEqual(PIN_BRUTE_FORCE_THRESHOLD);
      for (const fail of fails) {
        expect(fail.account).toBe(planned.victim);
        expect(fail.outcome).toBe("fail");
      }
    }
  });

  it("shares one detection window across every attacker", () => {
    const plan = planChaosWave(1000, idFor, randomLcg(7));
    // Every fail from every attacker falls inside the one shared window.
    for (const planned of plan.attackers) {
      for (const fail of runAttacker(planned, plan.window)) {
        expect(fail.ts).toBeGreaterThanOrEqual(plan.window.startTs);
        expect(fail.ts).toBeLessThanOrEqual(plan.window.endTs);
      }
    }
  });

  it("leaves CHAOS_WAVE_MARGIN_TICKS of clearance after each burst's last fail", () => {
    const plan = planChaosWave(1000, idFor, randomLcg(7));
    const marginTs = CHAOS_WAVE_MARGIN_TICKS * GAME_SECONDS_PER_TICK;
    for (const planned of plan.attackers) {
      const fails = runAttacker(planned, plan.window);
      const lastFailTs = Math.max(...fails.map((fail) => fail.ts));
      expect(lastFailTs).toBeLessThanOrEqual(plan.window.endTs - marginTs);
    }
  });

  it("is deterministic for a seed and trigger tick: same count, victims, and bursts", () => {
    const a = planChaosWave(1000, idFor, randomLcg(7));
    const b = planChaosWave(1000, idFor, randomLcg(7));
    expect(a.window).toEqual(b.window);
    expect(a.attackers.length).toBe(b.attackers.length);
    expect(a.attackers.map((x) => x.victim)).toEqual(b.attackers.map((x) => x.victim));
    expect(a.attackers.map((x) => x.evidenceCount)).toEqual(
      b.attackers.map((x) => x.evidenceCount),
    );
  });

  it("has no three-wave dependency: two independent triggers each mint a working wave", () => {
    const a = planChaosWave(1000, idFor, randomLcg(7));
    const b = planChaosWave(50_000, idFor, randomLcg(8));
    for (const planned of a.attackers) {
      expect(runAttacker(planned, a.window).length).toBeGreaterThanOrEqual(
        PIN_BRUTE_FORCE_THRESHOLD,
      );
    }
    for (const planned of b.attackers) {
      expect(runAttacker(planned, b.window).length).toBeGreaterThanOrEqual(
        PIN_BRUTE_FORCE_THRESHOLD,
      );
    }
  });

  it("rejects a negative or non-integer trigger tick", () => {
    expect(() => planChaosWave(-1, idFor, randomLcg(7))).toThrow(/triggerTick/);
    expect(() => planChaosWave(1.5, idFor, randomLcg(7))).toThrow(/triggerTick/);
  });
});
