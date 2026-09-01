/**
 * Shared helpers for the GH117 parity guards, split across `engine.test.ts` and
 * `engine-parity.test.ts`: the fields two runs' terminal snapshots must agree on, and
 * the blueprint-to-`ScenarioCastMember` mapping every live-cast test needs. One copy,
 * so a field added to `SimSnapshot` (or a field added to `ScenarioCastMember`) is a
 * single edit, not a search-and-hope across both files — a missed copy would silently
 * narrow what the parity guards compare while the assertion still passes.
 */
import type { buildBlueprint } from "../sim/scenarios/pin-brute-force/scenario";
import type { SimSnapshot } from "../sim/snapshot";
import type { ScenarioCastMember } from "./engine";

/** The scoring fields two runs must agree on, read off the terminal snapshot. */
export function scoringFields(snap: SimSnapshot): {
  status: SimSnapshot["status"];
  failureReason: SimSnapshot["failureReason"];
  admitted: number;
  completed: number;
  correctness: SimSnapshot["correctness"];
  decisions: SimSnapshot["decisions"];
  findings: SimSnapshot["findings"];
  queued: number;
} {
  return {
    status: snap.status,
    failureReason: snap.failureReason,
    admitted: snap.admitted,
    completed: snap.completed,
    correctness: snap.correctness,
    decisions: snap.decisions,
    findings: snap.findings,
    queued: snap.queued,
  };
}

/** Build the live scenario cast (members) from a seed's blueprint, aligned by index. */
export function membersOf(blueprint: ReturnType<typeof buildBlueprint>): ScenarioCastMember[] {
  const actors = blueprint.instantiate();
  return actors.map((actor, i) => {
    const d = blueprint.descriptors[i];
    if (!d) throw new Error("descriptor/actor misalignment");
    return { actor, kind: d.kind, provenance: d.provenance, initialPresence: d.initialPresence };
  });
}
