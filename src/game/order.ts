/**
 * Deterministic string ordering for the projection reducers.
 *
 * `localeCompare` is locale- and platform-dependent: its result can shift with the
 * runtime's ICU data or the host locale, which would let a sort order drift between
 * machines or Node builds. The sim and its projections must order identically
 * everywhere for a seed to replay (ARCHITECTURE rule 8), so ids are ordered by raw
 * UTF-16 code unit instead. That is stable, total, and has no locale to vary by.
 */

/** Compare two strings by UTF-16 code unit: a stable, locale-free ordering. */
export function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
