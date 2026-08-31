import { describe, expect, it } from "vitest";
import {
  CORRECTNESS_W_FN,
  CORRECTNESS_W_FP,
  CORRECTNESS_WINDOW,
  LEVEL_SEED,
  PIN_BRUTE_FORCE_THRESHOLD,
} from "../../../game/tuning";
import { createScorer } from "../../correctness";
import { isRawKioskV1, type RawKioskV1 } from "../../endpoints/kiosk/formats/kiosk-v1";
import type { PipeEvent } from "../../event";
import type { Finding } from "../../finding";
import {
  buildOptimizationAlgorithm,
  type OptimizationAlgorithm,
  optimizationSource,
} from "./optimization";
import { pinBruteForce } from "./scenario";

/**
 * Evaluate an Algorithm source string in-process and adapt it to `OptimizationAlgorithm`,
 * the same interface the typed twin implements. Strip the cosmetic lodash import (the
 * logic never calls it) so it runs offline, turn the `export` declarations into
 * module-local ones, and hand back the callables with a fresh closure each call.
 */
function loadSource(src: string): OptimizationAlgorithm {
  const body = src.replace(/^import .*$/m, "").replace(/^export\s+/gm, "");
  const factory = new Function(`${body}\nreturn { normalize, detect };`);
  const loaded: OptimizationAlgorithm = factory();
  return loaded;
}

/**
 * The Optimization is the incremental tally the player applies to survive the peak
 * (GH3-PLAN.md sections 6.5 and 13, M3). It must stay a CORRECT detector: catch
 * every Attack, raise one Alert per burst, and cite enough evidence to credit the
 * Attack through the scorer, so applying it is a speed win, not a correctness loss.
 */

/** Read an Event's kiosk-v1 payload, narrowing at the boundary. */
function raw(ev: PipeEvent): RawKioskV1 {
  if (!isRawKioskV1(ev.payload)) {
    throw new Error("expected a kiosk-v1 payload");
  }
  return ev.payload;
}

describe("optimizationSource", () => {
  it("imports lodash by absolute URL and exports the Rule, like a player would", () => {
    expect(optimizationSource).toContain('import _ from "https://esm.sh/lodash@4.17.21"');
    expect(optimizationSource).toContain("export function normalize");
    expect(optimizationSource).toContain("export function detect");
  });

  it("executes the same one-hit anchored shape as the typed twin (seam 4 parity)", () => {
    const source = loadSource(optimizationSource);
    const twin = buildOptimizationAlgorithm();
    const allFindings: Finding[] = [];
    for (let i = 0; i < PIN_BRUTE_FORCE_THRESHOLD + 2; i++) {
      const view = {
        account: "amy",
        terminal: "KIOSK-01",
        outcome: "fail" as const,
        id: i,
        ts: i * 10,
        endpoint: "kiosk-v1",
      };
      const sourceFindings = source.detect(view);
      // The live game runs the STRING, so its executed Findings must match the twin's.
      expect(sourceFindings).toEqual(twin.detect(view));
      allFindings.push(...sourceFindings);
    }
    // Exactly one hit over the burst, anchored on its first cited id, grouped by
    // account, and never a partial (the Optimization has no watch stage).
    expect(allFindings).toHaveLength(1);
    const hit = allFindings[0];
    expect(hit?.subjectType).toBe("account");
    expect(hit?.isPartial).toBeUndefined();
    expect(hit?.eventId).toBe(hit?.alert.eventIds[0]);
  });
});

describe("buildOptimizationAlgorithm", () => {
  it("scores 100 via the scorer over the whole run, catching every Attack", () => {
    const { events, attacks } = pinBruteForce.generate(LEVEL_SEED);
    const scorer = createScorer(attacks, {
      threshold: PIN_BRUTE_FORCE_THRESHOLD,
      window: CORRECTNESS_WINDOW,
      wFn: CORRECTNESS_W_FN,
      wFp: CORRECTNESS_W_FP,
    });
    const algo = buildOptimizationAlgorithm();

    for (const ev of events) {
      const norm = algo.normalize(raw(ev));
      const view = { ...norm, id: ev.id, ts: ev.ts, endpoint: ev.endpoint };
      // Hand the scorer the findings the way runDetect does: the scorer skips
      // partials itself, so pass them all as ScoredFinding (no subject here).
      const scored = algo.detect(view).map((finding) => ({ finding }));
      scorer.record(scored, ev);
    }
    scorer.finalize();

    const r = scorer.reading();
    expect(r.caught).toBe(attacks.length);
    expect(r.missed).toBe(0);
    expect(r.falseAlerts).toBe(0);
    expect(r.rolling).toBe(100);
  });

  it("raises exactly one anchored hit per burst, citing at least the threshold of evidence", () => {
    const algo = buildOptimizationAlgorithm();
    const hits: Finding[] = [];
    for (let i = 0; i < PIN_BRUTE_FORCE_THRESHOLD + 3; i++) {
      const findings = algo.detect({
        account: "amy",
        terminal: "KIOSK-01",
        outcome: "fail",
        id: i,
        ts: i * 10,
        endpoint: "kiosk-v1",
      });
      hits.push(...findings);
    }
    expect(hits).toHaveLength(1);
    const hit = hits[0];
    // A correct, faithful twin: one hit, anchored on the first cited id, grouped by
    // account, not a partial, citing at least the threshold of evidence.
    expect(hit?.isPartial).toBeUndefined();
    expect(hit?.subjectType).toBe("account");
    expect(hit?.eventId).toBe(hit?.alert.eventIds[0]);
    expect(hit?.alert.eventIds.length).toBeGreaterThanOrEqual(PIN_BRUTE_FORCE_THRESHOLD);
  });
});
