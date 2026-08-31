/**
 * The hunt color palette: a fixed cycling set of CSS tokens, assigned to a hunt
 * (reason token) on its first appearance in the run. Pure, no DOM, no store: the
 * caller decides which findings to scan and in what order, so a watch reserves a
 * slot the same way a hit does (GH37-PLAN.md "Hunt colors").
 */

/** The palette's CSS custom properties, defined in `index.css`. */
export const PALETTE_SIZE = 6;

/** The CSS var for the given palette slot, wrapping past `PALETTE_SIZE`. */
export function huntColorVar(index: number): string {
  const slot = ((index % PALETTE_SIZE) + PALETTE_SIZE) % PALETTE_SIZE;
  return `var(--hunt-${slot + 1})`;
}

/** Assigns and remembers one palette slot per reason token. */
export interface HuntPalette {
  /** The reason's assigned color var, assigning the next slot on its first call. */
  colorFor(reason: string): string;
  /** Clear every assignment, so the next `colorFor` call claims slot 0 again. */
  reset(): void;
}

/** A fresh palette with no reasons assigned yet. */
export function createHuntPalette(): HuntPalette {
  const slots = new Map<string, number>();
  let nextSlot = 0;
  return {
    colorFor(reason) {
      let slot = slots.get(reason);
      if (slot === undefined) {
        slot = nextSlot;
        nextSlot += 1;
        slots.set(reason, slot);
      }
      return huntColorVar(slot);
    },
    reset() {
      slots.clear();
      nextSlot = 0;
    },
  };
}
