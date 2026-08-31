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
import { resolveEntity } from "../../tasks";
import { buildReferenceAlgorithm, type ReferenceAlgorithm, referenceSource } from "./reference";
import { kioskPinAttack } from "./scenario";

/**
 * The live game loads the `referenceSource` STRING, not the typed twin, so its watch,
 * anchor, reason, and subject must be checked by executing it, not by matching
 * substrings. This file evaluates the source (with its cosmetic lodash import stripped,
 * which the logic never uses) and runs the same behavioral assertions as the twin. It
 * also folds the whole generated run through the scorer to prove the `kept[0]` anchor
 * stays stable, so no account ever holds a watch and a hit for one reason at once.
 */

/**
 * Evaluate an Algorithm source string in-process and adapt it to `ReferenceAlgorithm`,
 * the same interface the typed twin implements. The first line imports lodash by
 * absolute URL for parity with a real player, but the detection logic never calls it,
 * so we strip that line to run offline, then turn the `export` declarations into
 * module-local ones and hand back the two callables. Each call builds a fresh module,
 * so its closure state (the `fails`/`firing` maps) starts clean.
 */
function loadSource(src: string): ReferenceAlgorithm {
  const body = src.replace(/^import .*$/m, "").replace(/^export\s+/gm, "");
  const factory = new Function(`${body}\nreturn { normalize, detect };`);
  const loaded: ReferenceAlgorithm = factory();
  return loaded;
}

/** One fail Event on account "amy" in the flat view detect() reads. Its concrete
 *  shape is assignable to the typed twin's view, to DetectView, and to a plain record. */
function fail(
  id: number,
  ts: number,
): {
  account: string;
  terminal: string;
  outcome: "fail";
  id: number;
  ts: number;
  endpoint: string;
} {
  return { account: "amy", terminal: "KIOSK-01", outcome: "fail", id, ts, endpoint: "kiosk-v1" };
}

/** Read an Event's kiosk-v1 payload, narrowing at the boundary. */
function raw(ev: PipeEvent): RawKioskV1 {
  if (!isRawKioskV1(ev.payload)) {
    throw new Error("expected a kiosk-v1 payload");
  }
  return ev.payload;
}

describe("referenceSource (executed, seam 4 parity)", () => {
  it("imports lodash by absolute URL and exports the Rule, like a player would", () => {
    expect(referenceSource).toContain('import _ from "https://esm.sh/lodash@4.17.21"');
    expect(referenceSource).toContain("export function normalize");
    expect(referenceSource).toContain("export function detect");
  });

  it("runs the same watch-to-hit promotion as the typed twin when executed", () => {
    const source = loadSource(referenceSource);
    const twin = buildReferenceAlgorithm();

    for (let i = 0; i < 5; i++) {
      const view = fail(i, i * 10);
      // The source module and the typed twin must emit byte-identical Findings.
      expect(source.detect(view)).toEqual(twin.detect(view));
    }

    // Spell out the shape too, so a twin that also broke would not mask a source break.
    const first = loadSource(referenceSource);
    const watch = first.detect(fail(0, 0))[0];
    expect(watch?.isPartial).toBe(true);
    expect(watch?.eventId).toBe(0);
    expect(watch?.subjectType).toBe("account");
    expect(watch?.context).toEqual([{ type: "text", text: "1 of 5 wrong PINs" }]);
    for (let i = 1; i < 4; i++) {
      first.detect(fail(i, i * 10));
    }
    const hit = first.detect(fail(4, 40))[0];
    expect(hit?.isPartial).toBeUndefined();
    expect(hit?.eventId).toBe(0);
    expect(hit?.subjectType).toBe("account");
    expect(hit?.context).toEqual([
      {
        type: "kv",
        entries: [
          { label: "wrong PINs", value: 5 },
          { label: "threshold", value: 5 },
          { label: "window", value: 300 },
        ],
      },
    ]);
  });
});

describe("reference entity resolution through the real path (seam 5)", () => {
  it("resolves the hit's subjectType to the victim account, catching a broken subject", () => {
    const twin = buildReferenceAlgorithm();
    let hit: Finding | undefined;
    for (let i = 0; i < 5; i++) {
      const view = fail(i, i * 10);
      const findings = twin.detect(view).filter((f) => f.isPartial !== true);
      // Resolve against the same flat view runDetect builds, so subjectType "account"
      // reads the real field. A wrong subjectType would throw or resolve elsewhere.
      if (findings[0]) {
        hit = findings[0];
        expect(resolveEntity(findings[0], view)).toBe("amy");
      }
    }
    expect(hit).toBeDefined();
  });
});

describe("reference anchor stability over the real run (seam 9)", () => {
  it("never holds a watch and a hit for one account+reason at the same time", () => {
    const { events, attacks } = kioskPinAttack.generate(LEVEL_SEED);
    const scorer = createScorer(attacks, {
      threshold: PIN_BRUTE_FORCE_THRESHOLD,
      window: CORRECTNESS_WINDOW,
      wFn: CORRECTNESS_W_FN,
      wFp: CORRECTNESS_W_FP,
    });
    const algo = buildReferenceAlgorithm();

    for (const ev of events) {
      const norm = algo.normalize(raw(ev));
      const view = { ...norm, id: ev.id, ts: ev.ts, endpoint: ev.endpoint };
      // Resolve each finding's entity the way runDetect does, so the live entries carry
      // the same account grouping the panel would see.
      const scored = algo.detect(view).map((finding) => {
        const entity = resolveEntity(finding, view);
        return entity === undefined ? { finding } : { finding, entity };
      });
      scorer.record(scored, ev);

      // After every event, no (account, reason) may hold both a watch and a hit. That
      // is the stale-watch failure the `kept[0]` anchor avoids only while each burst
      // sits inside one detection window; this locks that assumption over the real run.
      const states = new Map<string, Set<string>>();
      for (const live of scorer.liveFindings()) {
        const key = `${live.entity ?? "?"}::${live.reason}`;
        const set = states.get(key) ?? new Set<string>();
        set.add(live.state);
        states.set(key, set);
      }
      for (const [key, set] of states) {
        expect(
          set.has("watch") && set.has("hit"),
          `account+reason ${key} held a watch and a hit at once`,
        ).toBe(false);
      }
    }
    scorer.finalize();
  });
});
