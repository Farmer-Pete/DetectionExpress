/**
 * The DEV fallback engine: the composed single engine, built from the SAME
 * discovery the registry uses (`registry.ts`'s `buildEngine`), so a new scenario
 * folder is picked up automatically here too, exactly as the registry picks it up.
 * The old version of this file hand-listed the kiosk normalizer and the
 * pin-brute-force rule directly, so a new scenario folder would silently never
 * appear in it; backing it with `buildEngine()` closes that drift.
 *
 * It lives in `game/`, not `sim/`: the registry's discovery is glob-backed
 * (`import.meta.glob`), and `sim/` stays free of that bundler coupling
 * (ARCHITECTURE.md). This module itself carries no glob of its own — it only
 * calls the one the registry already owns.
 *
 * It is the checked-in fallback `algorithms-resolve.ts`'s `DEFAULT_ENGINE_PATH`
 * points the resolver at when a player has no `src/algorithms/engine.ts` override.
 * It exports `normalize(raw, endpoint)` and `detect(e)` on the current contract:
 * `detect` returns a `Finding[]`, empty when nothing fires. `buildEngine()` builds
 * every rule's state fresh at load; a fresh import (the resolver loads it with a
 * cache-busting url nonce) rebuilds it, so a run replays cleanly.
 */
import { buildEngine } from "./registry";

const engine = buildEngine();

export const normalize = engine.normalize;
export const detect = engine.detect;
