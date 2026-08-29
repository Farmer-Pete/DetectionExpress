/**
 * The card entity: a fare card's identity, nothing more. A card is one physical
 * object with one id; the balance is not on the card, because a balance is running
 * state only the rider changes (ADR-0007). `buildCards` mints a seeded, distinct
 * pool at scenario assembly, where each card gets exactly one rider.
 */

export interface Card {
  /** The media serial, e.g. "C09". */
  id: string;
}

/**
 * A deterministic pool of `count` distinct card ids drawn from the seeded rng. The
 * same seed always mints the same pool, and every id is distinct so one card's tap
 * stream is one rider's journey and never two interleaved.
 */
export function buildCards(count: number, rng: () => number): Card[] {
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(`buildCards: count must be a finite non-negative integer, got ${count}.`);
  }
  const ids = new Set<string>();
  const span = Math.max(100, count * 4);
  while (ids.size < count) {
    const number = Math.floor(rng() * span);
    ids.add(`C${number.toString().padStart(2, "0")}`);
  }
  return [...ids].map((id) => ({ id }));
}
