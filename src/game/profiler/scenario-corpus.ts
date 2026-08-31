/**
 * The profiler's stable corpus contract. The registry carries a `ScenarioCorpus`
 * on each `ScenarioRegistryEntry`, and `game/profiler/corpus.ts` reads it from
 * there rather than importing a scenario folder directly. So a scenario can reshape
 * its `cast.ts`/`pin-attacker.ts` without touching the profiler, and adding a
 * scenario never owes the profiler a private import.
 *
 * The member types are pinned to the kiosk cast today, since one world model exists
 * (GH42-PLAN.md's non-goal against premature abstraction). A second scenario that
 * needs a different corpus generalizes this contract then.
 */
import type {
  assembleAttacker,
  assemblePatron,
  buildIdentityPools,
  pickSeeded,
} from "../../sim/scenarios/pin-brute-force/cast";

export interface ScenarioCorpus {
  assembleAttacker: typeof assembleAttacker;
  assemblePatron: typeof assemblePatron;
  buildIdentityPools: typeof buildIdentityPools;
  pickSeeded: typeof pickSeeded;
  /** Ticks the attacker arrives ahead of its burst. */
  arriveLeadTicks: number;
  /** The scenario's alert reason, e.g. "pin_brute_force". */
  reason: string;
}

/**
 * Is `value` a usable `ScenarioCorpus`? Validated at the registry glob seam, so a
 * scenario that ships a malformed corpus fails at load, not deep inside the
 * profiler's corpus build far from the cause.
 */
/** A string primitive, by its tag rather than a `typeof` check (repo anti-slop idiom). */
function isString(value: unknown): value is string {
  return !(value instanceof Object) && Object.prototype.toString.call(value) === "[object String]";
}

/** A number primitive, by its tag rather than a `typeof` check (repo anti-slop idiom). */
function isNumber(value: unknown): value is number {
  return !(value instanceof Object) && Object.prototype.toString.call(value) === "[object Number]";
}

export function isScenarioCorpus(value: unknown): value is ScenarioCorpus {
  return (
    value instanceof Object &&
    "assembleAttacker" in value &&
    value.assembleAttacker instanceof Function &&
    "assemblePatron" in value &&
    value.assemblePatron instanceof Function &&
    "buildIdentityPools" in value &&
    value.buildIdentityPools instanceof Function &&
    "pickSeeded" in value &&
    value.pickSeeded instanceof Function &&
    "arriveLeadTicks" in value &&
    isNumber(value.arriveLeadTicks) &&
    "reason" in value &&
    isString(value.reason)
  );
}
