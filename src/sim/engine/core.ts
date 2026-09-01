// The shared engine core. Every rule imports its helpers from here, and the
// assembler inlines this once, above the rules, so a rule never re-defines them.
// Pure logic, no React, no bundler globs.

/** Keep only the items whose `ts` sits inside the trailing window ending at `now`. */
export function withinWindow<T extends { ts: number }>(
  items: T[],
  now: number,
  windowSeconds: number,
): T[] {
  // The `x.ts <= now` upper bound is a no-op under the in-order stream (no item
  // arrives from the future), but it hardens this shared core against out-of-order input.
  return items.filter((x) => x.ts > now - windowSeconds && x.ts <= now);
}
