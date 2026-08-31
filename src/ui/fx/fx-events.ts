/**
 * Pure diffs over the two arrays FxLayer watches each tick: the sim's live findings
 * and its decision log. No DOM, no store, no timing: FxLayer decides what to spawn
 * from what these return (GH37-PLAN.md "What 'a finding lands' means").
 */
import type { CaughtDecision, Decision, FalseDecision, LiveFinding } from "../../sim/correctness";

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

/**
 * F012: the caught/false decisions among `newDecisions` whose crediting finding never
 * landed through `diffFindings` this run. A fast rule can record a decision and
 * consume the end-of-stream marker inside the same tick's microtask phase, so
 * `finalize()` clears the live set before any snapshot samples the hit — the decision
 * lands durably in the log, but its finding never appears in a sampled `findings`
 * array, so `diffFindings` never fires for it. `firedSeqs` is keyed on `liveSeq`
 * exactly like a finding's own `seq`, so a decision whose finding WAS sampled first
 * (already in `firedSeqs`) is excluded here, and a missed decision (no finding, no
 * `liveSeq`) is excluded outright.
 */
export function unfiredLandingDecisions(
  newDecisions: readonly Decision[],
  firedSeqs: ReadonlySet<number>,
): readonly (CaughtDecision | FalseDecision)[] {
  const unfired: (CaughtDecision | FalseDecision)[] = [];
  for (const decision of newDecisions) {
    if (decision.outcome === "missed" || firedSeqs.has(decision.liveSeq)) {
      continue;
    }
    unfired.push(decision);
  }
  return unfired;
}
