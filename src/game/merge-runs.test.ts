import { describe, expect, it } from "vitest";
import { createScorer } from "../sim/correctness";
import { isRawKioskV1 } from "../sim/endpoints/kiosk/formats/kiosk-v1";
import type { DetectView } from "../sim/finding";
import { mergeRuns } from "../sim/merge-runs";
import { generate } from "../sim/scenarios/pin-brute-force/scenario";
import { PIN_BRUTE_FORCE_THRESHOLD } from "../sim/scenarios/pin-brute-force/tuning";
import { buildEngine } from "./registry";
import { CORRECTNESS_W_FN, CORRECTNESS_W_FP, CORRECTNESS_WINDOW, LEVEL_SEED } from "./tuning";

// GH42-PLAN.md "Composable streams: the merge seam" + "Scoring for mixed hunts": two
// pin-brute-force runs, differently seeded and drawn from disjoint identity
// partitions, merge into one stream that the ONE composed engine scores as if it
// were a single run.
describe("mergeRuns + the registry-composed engine (M4)", () => {
  it("scores 100 across two merged, partitioned pin-brute-force runs thrown at one engine", () => {
    const runA = generate(LEVEL_SEED, 0);
    const runB = generate(2026, 1);
    const merged = mergeRuns([runA, runB]);

    // The visible shape a caller relies on: every Attack survives the merge with a
    // globally unique id, and the shared schedule is kept, not concatenated.
    expect(merged.attacks.length).toBe(runA.attacks.length + runB.attacks.length);
    expect(new Set(merged.attacks.map((a) => a.id)).size).toBe(merged.attacks.length);
    expect(merged.waves).toEqual(runA.waves);
    expect(merged.checkpoints).toEqual(runA.checkpoints);

    const engine = buildEngine();
    const scorer = createScorer(merged.attacks, {
      threshold: PIN_BRUTE_FORCE_THRESHOLD,
      window: CORRECTNESS_WINDOW,
      wFn: CORRECTNESS_W_FN,
      wFp: CORRECTNESS_W_FP,
    });

    for (const ev of merged.events) {
      if (!isRawKioskV1(ev.payload)) {
        throw new Error("expected a kiosk-v1 payload");
      }
      const norm = engine.normalize(ev.payload, ev.endpoint);
      const view: DetectView = { ...norm, id: ev.id, ts: ev.ts, endpoint: ev.endpoint };
      const scored = engine.detect(view).map((finding) => ({ finding }));
      scorer.record(scored, ev);
    }
    scorer.finalize();

    const reading = scorer.reading();
    expect(reading.caught).toBe(merged.attacks.length);
    expect(reading.missed).toBe(0);
    expect(reading.falseAlerts).toBe(0);
    expect(reading.rolling).toBe(100);
  });
});
