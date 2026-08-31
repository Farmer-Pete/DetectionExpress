/**
 * The default detection engine: the composed single engine, wired for the one
 * scenario shipped today. It is `createEngine` over the kiosk normalizers and the
 * pin-brute-force rule factory, so it detects the hunt through the same normalize
 * dispatch and rule routing the registry composes. It is the checked-in fallback the
 * resolver loads when a player has no `src/algorithms/engine.ts` override.
 *
 * It exports `normalize(raw, endpoint)` and `detect(e)` on the current contract:
 * `detect` returns a `Finding[]`, empty when nothing fires. The rule's state lives in
 * the built rule this module composes once at load; a fresh import (the resolver loads
 * it with a cache-busting url nonce) rebuilds it, so a run replays cleanly.
 *
 * There is no hand-maintained twin here any more: the logic lives once in
 * `scenarios/pin-brute-force/rule.ts` and `endpoints/kiosk/normalize.ts`, and this
 * engine, the in-process twin (`reference.ts`), and the assembled editor source all
 * derive from those files.
 */
import { normalizers as kioskNormalizers } from "./endpoints/kiosk/normalize";
import { createEngine } from "./engine/engine";
import { buildRule as buildPinBruteForceRule } from "./scenarios/pin-brute-force/rule";

const engine = createEngine({
  normalizers: kioskNormalizers,
  rules: [buildPinBruteForceRule],
});

export const normalize = engine.normalize;
export const detect = engine.detect;
