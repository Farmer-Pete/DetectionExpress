/**
 * The separability helper (GH42-PLAN.md "the scenario scaffold"). It is the
 * count-in-a-window proof the catalogue's threshold-shaped hunts share: group
 * records by key, sweep each key's own timeline for the worst rolling window, and
 * throw the moment `threshold` or more qualifying records land inside one window
 * that is NOT wholly explained by that key's own Attack. A generation bug that
 * lets a stray crossing slip in front of a player would otherwise surface as an
 * unwinnable run; this fails loudly at generation time instead (ARCHITECTURE rule
 * 9). A Scenario whose evidence has a different shape (a sequence, a join, a
 * baseline) supplies its own check instead of this one.
 */
import type { Attack } from "./attack";

export interface AssertThresholdInWindowInput<Rec> {
  /** The candidate records to sweep. Any order; each key's own records are sorted here. */
  records: readonly Rec[];
  /** How many qualifying records inside one window makes a crossing. */
  threshold: number;
  /** The rolling window's length, in the same units `tsOf` returns. */
  window: number;
  /** The entity a record groups on, e.g. an account. */
  keyOf: (record: Rec) => string;
  /** The record's time. */
  tsOf: (record: Rec) => number;
  /** True when a record counts toward the threshold, e.g. a failed attempt. */
  qualifies: (record: Rec) => boolean;
  /** The Attack window `key` owns, if any. A crossing entirely inside it is expected evidence, not a stray. */
  attackWindowOf: (key: string) => Attack["window"] | undefined;
}

/**
 * Throws the first time some key's qualifying records cross `threshold` inside a
 * rolling `window`, unless every record in that crossing falls inside `key`'s own
 * Attack window. Records may arrive in any order.
 */
export function assertThresholdInWindow<Rec>(input: AssertThresholdInWindowInput<Rec>): void {
  const { records, threshold, window, keyOf, tsOf, qualifies, attackWindowOf } = input;

  const byKey = new Map<string, Rec[]>();
  for (const record of records) {
    if (!qualifies(record)) {
      continue;
    }
    const key = keyOf(record);
    const list = byKey.get(key);
    if (list === undefined) {
      byKey.set(key, [record]);
    } else {
      list.push(record);
    }
  }

  for (const [key, unsorted] of byKey) {
    const sorted = [...unsorted].sort((a, b) => tsOf(a) - tsOf(b));
    const attackWindow = attackWindowOf(key);
    let start = 0;
    for (let end = 0; end < sorted.length; end++) {
      const endRecord = sorted[end];
      if (endRecord === undefined) {
        continue;
      }
      const endTs = tsOf(endRecord);
      while (true) {
        const startRecord = sorted[start];
        if (startRecord === undefined || endTs - tsOf(startRecord) < window) {
          break;
        }
        start++;
      }
      const inWindow = sorted.slice(start, end + 1);
      if (inWindow.length < threshold) {
        continue;
      }
      const insideAttack =
        attackWindow !== undefined &&
        inWindow.every((r) => tsOf(r) >= attackWindow.startTs && tsOf(r) <= attackWindow.endTs);
      if (!insideAttack) {
        throw new Error(
          `"${key}" crosses the threshold of ${threshold} within a ${window}-unit window outside any Attack.`,
        );
      }
    }
  }
}
