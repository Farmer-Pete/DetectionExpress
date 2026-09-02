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
import { planChaosWave } from "./chaos-wave";
import { PIN_BRUTE_FORCE_THRESHOLD } from "./tuning";

const env: WorldEnv = {
  world,
  distances: distanceTable(world),
  timetable: buildTimetable(world),
};

/** A kiosk payload, narrowed off the discriminated union. */
function kioskOf(reading: WorldReading): AccountKioskReading {
  if (reading.sensor !== "kiosk") {
    throw new Error(`expected a kiosk reading, got "${reading.sensor}".`);
  }
  return reading.reading;
}

/**
 * Run one chaos-wave plan's attacker straight to just past its window's close,
 * collecting its kiosk fails. One `advanceTo` call suffices: the scheduler pops
 * every due actor below the horizon in one pass.
 */
function runAttacker(plan: ReturnType<typeof planChaosWave>): AccountKioskReading[] {
  const schedule = createSchedule({ actors: [plan.attacker.build()], env, runSeed: 1 });
  const horizon = plan.window.endTs / GAME_SECONDS_PER_TICK + 5;
  const step = schedule.advanceTo(horizon);
  return step.readings.map((timed) => kioskOf(timed.reading));
}

// GH126-PLAN.md M2a seam 14 (Codex N4): the single-attack chaos-wave seam mints one
// attacker, one victim from the attack namespace, and a fail burst at or above
// threshold, independent of `planAttacks`'s three-wave escalation.
describe("planChaosWave", () => {
  it("mints one attacker on one victim from the attack namespace, with a fail burst at or above threshold", () => {
    const plan = planChaosWave(1000, "chaos-attacker-1", randomLcg(7));
    expect(plan.attacker.kind).toBe("pin-attacker");
    expect(ATTACK_ACCOUNT_NAMESPACE).toContain(plan.victim);
    expect(BENIGN_ACCOUNT_NAMESPACE).not.toContain(plan.victim);
    expect(plan.threshold).toBe(PIN_BRUTE_FORCE_THRESHOLD);

    const fails = runAttacker(plan);
    expect(fails.length).toBeGreaterThanOrEqual(PIN_BRUTE_FORCE_THRESHOLD);
    for (const fail of fails) {
      expect(fail.account).toBe(plan.victim);
      expect(fail.outcome).toBe("fail");
    }
  });

  it("has no three-wave dependency: two independent triggers each mint exactly one working attacker", () => {
    const a = planChaosWave(1000, "chaos-attacker-a", randomLcg(7));
    const b = planChaosWave(50_000, "chaos-attacker-b", randomLcg(8));
    expect(runAttacker(a).length).toBeGreaterThanOrEqual(PIN_BRUTE_FORCE_THRESHOLD);
    expect(runAttacker(b).length).toBeGreaterThanOrEqual(PIN_BRUTE_FORCE_THRESHOLD);
  });

  it("exposes an evidence count at or above threshold, matching the attacker's fail burst", () => {
    const plan = planChaosWave(1000, "chaos-attacker-2", randomLcg(7));
    // `evidenceCount` is the distinct-evidence count the removed `toAttack` used to
    // assert against threshold; it must equal the number of fails the attacker emits.
    expect(plan.evidenceCount).toBeGreaterThanOrEqual(PIN_BRUTE_FORCE_THRESHOLD);
    expect(runAttacker(plan).length).toBe(plan.evidenceCount);
  });

  it("is deterministic for a seed and trigger tick", () => {
    const a = planChaosWave(1000, "chaos-attacker-3", randomLcg(7));
    const b = planChaosWave(1000, "chaos-attacker-3", randomLcg(7));
    expect(a.victim).toBe(b.victim);
    expect(a.window).toEqual(b.window);
  });

  it("rejects a negative or non-integer trigger tick", () => {
    expect(() => planChaosWave(-1, "chaos-attacker-4", randomLcg(7))).toThrow(/triggerTick/);
    expect(() => planChaosWave(1.5, "chaos-attacker-4", randomLcg(7))).toThrow(/triggerTick/);
  });
});
