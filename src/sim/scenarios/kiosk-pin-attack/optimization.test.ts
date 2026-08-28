import { describe, expect, it } from "bun:test";
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
import { buildOptimizationAlgorithm, optimizationSource } from "./optimization";
import { kioskPinAttack } from "./scenario";

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
    expect(optimizationSource).toContain("export function match");
  });
});

describe("buildOptimizationAlgorithm", () => {
  it("scores 100 via the scorer over the whole run, catching every Attack", () => {
    const { events, attacks } = kioskPinAttack.generate(LEVEL_SEED);
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
      scorer.record(algo.match(view), ev);
    }
    scorer.finalize();

    const r = scorer.reading();
    expect(r.caught).toBe(attacks.length);
    expect(r.missed).toBe(0);
    expect(r.falseAlerts).toBe(0);
    expect(r.rolling).toBe(100);
  });

  it("raises exactly one Alert per burst, citing at least the threshold of evidence", () => {
    const algo = buildOptimizationAlgorithm();
    let alerts = 0;
    let citedEnough = true;
    for (let i = 0; i < PIN_BRUTE_FORCE_THRESHOLD + 3; i++) {
      const alert = algo.match({
        account: "amy",
        terminal: "KIOSK-01",
        outcome: "fail",
        id: i,
        ts: i * 10,
        endpoint: "kiosk-v1",
      });
      if (alert && !Array.isArray(alert)) {
        alerts += 1;
        if (alert.events.length < PIN_BRUTE_FORCE_THRESHOLD) {
          citedEnough = false;
        }
      }
    }
    expect(alerts).toBe(1);
    expect(citedEnough).toBe(true);
  });
});
