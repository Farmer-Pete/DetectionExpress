/**
 * The pin-brute-force scenario's public face, as the registry and the profiler
 * read it. One glob over `scenarios/*​/index.ts` feeds three consumers from here:
 * the UI reads `scenario`, the engine reads `buildRule` (the rule factory), and
 * the profiler reads `corpus`.
 *
 * `corpus` is the stable profiler contract (GH42-PLAN.md "the cast and the
 * profiler"): the exact primitives `game/profiler/corpus.ts` and `rules.ts` build
 * the calibration corpus and its two priced rules from. The profiler imports only
 * this, never a folder internal (`./cast`, `./pin-attacker`, `./attacks`)
 * directly, so this scenario can reshape those files without breaking the
 * profiler. The cast itself stays local (not graduated to `src/sim/actors/`): no
 * second scenario casts the PIN attacker yet (ARCHITECTURE's graduation rule).
 */

import { PIN_BRUTE_FORCE_REASON } from "./attacks";
import { assembleAttacker, assemblePatron, buildIdentityPools, pickSeeded } from "./cast";
import { ARRIVE_LEAD_TICKS } from "./pin-attacker";

export const corpus = {
  assembleAttacker,
  assemblePatron,
  buildIdentityPools,
  pickSeeded,
  arriveLeadTicks: ARRIVE_LEAD_TICKS,
  reason: PIN_BRUTE_FORCE_REASON,
};

export { buildRule } from "./rule";
export { pinBruteForce as scenario } from "./scenario";
