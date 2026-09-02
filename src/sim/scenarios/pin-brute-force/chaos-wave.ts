/**
 * The single-attack chaos-wave planning seam (GH126-PLAN.md M2a item 3, Codex N4).
 * Mints ONE PIN attacker on ONE victim drawn from the attack account namespace,
 * rebased to a live trigger tick, independent of `planAttacks`'s three-wave
 * escalation — one attack, one wave, every time. Reuses the same pin-attacker
 * actor, victim-selection (`selectVictims`), and Attack composition
 * (`attackFromPlan`) primitives the three-wave path uses, so the two paths share
 * one mechanism rather than diverging into two.
 *
 * The engine caller (M2b) admits `attacker` through `schedule.admit()`, calls
 * `scorer.addAttack(...)` with `victim`/`window`/`threshold` BEFORE any evidence
 * exists, binds each fail's global event id as it is offered
 * (`scorer.bindEvidence`), then calls `toAttack` once every fail has its id, to
 * build the final Ground-truth Attack.
 */
import { GAME_SECONDS_PER_TICK } from "../../../game/tuning";
import { ATTACK_ACCOUNT_NAMESPACE } from "../../actors/account-namespace";
import type { ActorDescriptor } from "../../actors/actor";
import type { Attack } from "../../attack";
import { KIOSK_TERMINALS } from "../../endpoints/kiosk/internal";
import { world } from "../../world/world";
import type { WorldEnv, WorldReading } from "../../world-reading";
import { type AttackPlan, attackFromPlan, selectVictims } from "./attacks";
import { assembleAttacker, pickSeeded } from "./cast";
import { ARRIVE_LEAD_TICKS } from "./pin-attacker";
import { PIN_BRUTE_FORCE_THRESHOLD, SCAN_WINDOW_TICKS } from "./tuning";

/**
 * Ticks of clearance the burst's detection window leaves after its last fail, so
 * the window strictly contains the burst with room to spare. Mirrors `attacks.ts`'s
 * own `BURST_MARGIN_TICKS`.
 */
const CHAOS_WAVE_MARGIN_TICKS = 20;

/** One planned chaos wave: its single attacker, victim, window, and threshold. */
export interface ChaosWavePlan {
  /** The one attacker actor descriptor. The caller admits it through `schedule.admit()`. */
  attacker: ActorDescriptor<WorldReading, WorldEnv>;
  /** The victim account, drawn from the attack namespace, disjoint from every benign account. */
  victim: string;
  /** The attack's detection window, rebased to the trigger tick. */
  window: { startTs: number; endTs: number };
  /** This hunt's evidence threshold (`PIN_BRUTE_FORCE_THRESHOLD`). */
  threshold: number;
  /**
   * Build the Ground-truth Attack once every fail reading has its global event id,
   * in emission order. Asserts `new Set(eventIds).size >= threshold`: the check
   * `createScorer` used to run at attack registration, now run here instead now
   * that `addAttack` registers before any evidence exists (Codex N3).
   */
  toAttack(id: number, eventIds: number[]): Attack;
}

/**
 * Plan one chaos wave: one attacker, one victim from the attack namespace, and one
 * PIN fail burst at or above threshold, all rebased to `triggerTick`. Independent
 * of `planAttacks`'s three-wave escalation. `actorId` is minted by the caller (the
 * engine owns actor-id policy, e.g. a WaveId-derived name); this seam only plans
 * the burst itself.
 */
export function planChaosWave(
  triggerTick: number,
  actorId: string,
  rng: () => number,
): ChaosWavePlan {
  if (!Number.isInteger(triggerTick) || triggerTick < 0) {
    throw new Error(
      `planChaosWave: triggerTick must be a non-negative integer, got ${triggerTick}.`,
    );
  }
  const [victim] = selectVictims(ATTACK_ACCOUNT_NAMESPACE, rng, 1);
  if (victim === undefined) {
    throw new Error("planChaosWave: the attack account namespace is empty.");
  }
  const station = pickSeeded(
    world.stations.map((s) => s.id),
    rng,
  );
  const terminal = pickSeeded(KIOSK_TERMINALS, rng);

  // Between threshold and threshold + 3 fails, mirroring `planAttacks`'s own burst draw.
  const count = PIN_BRUTE_FORCE_THRESHOLD + Math.floor(rng() * 4);
  const spanTicks = SCAN_WINDOW_TICKS - CHAOS_WAVE_MARGIN_TICKS;
  if (spanTicks < count - 1) {
    throw new RangeError("planChaosWave: the detection window is too short for the burst.");
  }
  const startTick = triggerTick + ARRIVE_LEAD_TICKS;
  const gap = count > 1 ? spanTicks / (count - 1) : 0;
  const failTimestamps: number[] = [];
  for (let k = 0; k < count; k++) {
    const tick = startTick + Math.round(k * gap);
    failTimestamps.push(tick * GAME_SECONDS_PER_TICK);
  }

  const window = {
    startTs: startTick * GAME_SECONDS_PER_TICK,
    endTs: (startTick + spanTicks) * GAME_SECONDS_PER_TICK,
  };

  // `attackId: 0` is a placeholder: this seam discards `assembleAttacker`'s label
  // tuple (the batch composer's actor-id -> attack-id ground-truth attribution),
  // since the live engine attributes evidence directly through
  // `scorer.bindEvidence`, never through `attackIdOf`/labels.
  const { descriptor } = assembleAttacker({
    id: actorId,
    attackId: 0,
    account: victim,
    station,
    terminal,
    failTimestamps,
  });

  return {
    attacker: descriptor,
    victim,
    window,
    threshold: PIN_BRUTE_FORCE_THRESHOLD,
    toAttack(id, eventIds) {
      const distinctEvidence = new Set(eventIds).size;
      if (distinctEvidence < PIN_BRUTE_FORCE_THRESHOLD) {
        throw new Error(
          `planChaosWave: attack ${id} has ${distinctEvidence} distinct evidence ids but a ` +
            `threshold of ${PIN_BRUTE_FORCE_THRESHOLD}, so no Alert could ever satisfy it.`,
        );
      }
      const plan: AttackPlan = { id, account: victim, window, failTimestamps };
      return attackFromPlan(plan, eventIds);
    },
  };
}
