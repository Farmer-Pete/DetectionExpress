/**
 * A pure per-wave seed (GH126-PLAN.md M2a item 2, Q11): "the engine handle
 * captures the live tick, then seeds and rebases the wave." A chaos wave is
 * click-triggered, so its trigger tick is not itself deterministic run over run,
 * but ONE wave, given the tick it fired on, must replay identically. Mixing the
 * run seed with the trigger tick, through the same string mixer every actor's own
 * per-run seed already goes through (`actorSeedHash`), gives exactly that: a
 * fresh, deterministic, distinct-per-tick seed with no new hashing scheme to
 * maintain.
 */
import { actorSeedHash } from "./actors/actor";

/** Derive one chaos wave's seed from the run seed and the tick it triggered on. */
export function waveSeed(runSeed: number, triggerTick: number): number {
  return actorSeedHash(runSeed, `wave:${triggerTick}`);
}
