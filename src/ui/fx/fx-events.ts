/**
 * Pure diffs over the two arrays FxLayer watches each tick: the sim's live findings
 * and its decision log. No DOM, no store, no timing: FxLayer decides what to spawn
 * from what these return (GH37-PLAN.md "What 'a finding lands' means").
 */
import type { Decision, LiveFinding } from "../../sim/correctness";

/**
 * The findings that just landed: a `LiveFinding` reaching state "hit" for the FIRST
 * time this run. Covers both a brand-new hit and a watch promoting to a hit. A
 * finding that arrives as a new watch fires nothing, and a hit -> hit re-emit (e.g. a
 * grown `eventIds`) is not a landing, since its state did not change this delta.
 * `firedSeqs` additionally excludes a seq the caller already fired for, so a
 * hit -> watch -> hit cycle refires only the first time.
 */
export function diffFindings(
  prev: readonly LiveFinding[],
  next: readonly LiveFinding[],
  firedSeqs: ReadonlySet<number>,
): readonly LiveFinding[] {
  const prevBySeq = new Map(prev.map((f) => [f.seq, f] as const));
  const landed: LiveFinding[] = [];
  for (const finding of next) {
    if (finding.state !== "hit" || firedSeqs.has(finding.seq)) {
      continue;
    }
    const before = prevBySeq.get(finding.seq);
    if (before !== undefined && before.state === "hit") {
      continue; // already a hit last tick: a re-emit, not a landing
    }
    landed.push(finding);
  }
  return landed;
}

/**
 * The decisions appended since `prevLength`. The log is append-only, so a slice from
 * the prior length is exactly the new tail; a caller who resets `prevLength` to 0
 * after a run restart naturally reads the fresh log as all new, with no reset logic
 * needed here.
 */
export function diffDecisions(
  prevLength: number,
  decisions: readonly Decision[],
): readonly Decision[] {
  return decisions.slice(prevLength);
}
