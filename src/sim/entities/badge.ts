/**
 * The badge entity: a staff credential's identity and its grade ceiling, nothing
 * more. A badge is one physical pass with one id; the grade ceiling is the highest
 * trust zone it may enter (a door's grade is `zone.trustLevel`). `buildBadges` mints
 * a seeded, distinct pool at scenario assembly, mirroring `card.ts`; a badge is a
 * credential, so it can outlive one staff visit and be carried by another (ADR-0007).
 */

/** The lowest and highest staff grade ceiling: z2 (Staff) through z4 (Control). */
const MIN_GRADE = 2;
const GRADE_SPAN = 3;

export interface Badge {
  /** The credential id, e.g. "B204". */
  id: string;
  /** The highest zone trust level this badge may enter (2..4). */
  grade: number;
}

/**
 * A deterministic pool of `count` distinct badges drawn from the seeded rng. The
 * same seed always mints the same pool: each id is distinct (so one badge's grants
 * are one credential's crossings, never two interleaved), and each carries a grade
 * ceiling in `[MIN_GRADE, MIN_GRADE + GRADE_SPAN)`. Ids are drawn first, then a grade
 * per id, so the draw order is fixed and the pool replays for a seed.
 */
export function buildBadges(count: number, rng: () => number): Badge[] {
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(`buildBadges: count must be a finite non-negative integer, got ${count}.`);
  }
  const ids = new Set<string>();
  const span = Math.max(100, count * 4);
  while (ids.size < count) {
    const number = Math.floor(rng() * span);
    ids.add(`B${number.toString().padStart(3, "0")}`);
  }
  return [...ids].map((id) => ({ id, grade: MIN_GRADE + Math.floor(rng() * GRADE_SPAN) }));
}
