// The shared engine core. Every rule imports its helpers from here, and the
// assembler inlines this once, above the rules, so a rule never re-defines them.
// Pure logic, no React, no bundler globs.

/** Keep only the items whose `ts` sits inside the trailing window ending at `now`. */
export function withinWindow<T extends { ts: number }>(
  items: T[],
  now: number,
  windowSeconds: number,
): T[] {
  return items.filter((x) => x.ts > now - windowSeconds);
}
