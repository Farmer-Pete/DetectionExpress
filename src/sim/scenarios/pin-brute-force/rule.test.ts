import { describe, expect, it } from "vitest";
import { kioskV1 } from "../../endpoints/kiosk/formats/kiosk-v1";
import type { DetectView } from "../../finding";
import { PIN_BRUTE_FORCE_REASON } from "./attacks";
import { buildRule } from "./rule";

/** One fail Event on account "amy" in the flat view detect() reads. */
function fail(id: number, ts: number): DetectView {
  return { account: "amy", terminal: "KIOSK-01", outcome: "fail", id, ts, endpoint: "kiosk-v1" };
}

describe("pin-brute-force rule identity", () => {
  it("declares its hunt id and reads the kiosk-v1 endpoint, without drift", () => {
    const rule = buildRule();
    expect(rule.id).toBe("pin-brute-force");
    expect(rule.endpoints).toEqual([kioskV1.id]);
  });

  it("names the shared reason token", () => {
    // The rule inlines the literal reason; guard it against the shared ground-truth token.
    const rule = buildRule();
    const watch = rule.detect(fail(0, 0))[0];
    expect(watch?.alert.reason).toBe(PIN_BRUTE_FORCE_REASON);
  });
});

describe("pin-brute-force watch-to-hit promotion", () => {
  it("emits four anchored watches, then one hit on the same anchor and reason", () => {
    const rule = buildRule();
    const perStep: ReturnType<typeof rule.detect>[] = [];
    for (let i = 0; i < 5; i++) {
      perStep.push(rule.detect(fail(i, i * 10)));
    }

    for (let n = 1; n <= 4; n++) {
      const watch = (perStep[n - 1] ?? [])[0];
      expect(watch?.isPartial).toBe(true);
      expect(watch?.eventId).toBe(0);
      expect(watch?.subjectType).toBe("account");
      expect(watch?.alert.reason).toBe("pin_brute_force");
      expect(watch?.context).toEqual([{ type: "text", text: `${n} of 5 wrong PINs` }]);
    }

    const hit = (perStep[4] ?? [])[0];
    expect(hit?.isPartial).toBeUndefined();
    expect(hit?.eventId).toBe(0);
    expect(hit?.subjectType).toBe("account");
    expect(hit?.alert.reason).toBe("pin_brute_force");
    expect(hit?.alert.eventIds).toEqual([0, 1, 2, 3, 4]);
    expect(hit?.context).toEqual([
      {
        type: "kv",
        entries: [
          { label: "wrong PINs", value: 5 },
          { label: "threshold", value: 5 },
          { label: "window", value: "5:00" },
        ],
      },
    ]);
  });

  it("raises exactly one hit per burst, not one per fail past the threshold", () => {
    const rule = buildRule();
    const hits: number[] = [];
    for (let i = 0; i < 8; i++) {
      const fired = rule.detect(fail(i, i * 10)).filter((f) => f.isPartial !== true);
      hits.push(fired.length);
    }
    // Fails 0..3 are watches (0 hits); fail 4 is the one hit; fails 5..7 add none.
    expect(hits).toEqual([0, 0, 0, 0, 1, 0, 0, 0]);
  });

  it("never fires for a benign fumble that stays under the threshold", () => {
    const rule = buildRule();
    let firedHits = 0;
    for (let i = 0; i < 4; i++) {
      firedHits += rule.detect(fail(i, i * 10)).filter((f) => f.isPartial !== true).length;
    }
    // A success in the middle does not count; still no hit.
    rule.detect({ ...fail(99, 45), outcome: "success" });
    expect(firedHits).toBe(0);
  });
});

describe("pin-brute-force rule state isolation", () => {
  it("two fresh instances replay a burst identically", () => {
    const a = buildRule();
    const b = buildRule();
    const seq = [fail(0, 0), fail(1, 10), fail(2, 20), fail(3, 30), fail(4, 40)];
    const fromA = seq.flatMap((e) => a.detect(e));
    const fromB = seq.flatMap((e) => b.detect(e));
    expect(fromA).toEqual(fromB);
  });

  it("does not let one instance's burst leak into another", () => {
    const a = buildRule();
    for (let i = 0; i < 5; i++) {
      a.detect(fail(i, i * 10));
    }
    // A fresh instance seeing two fails is below threshold: one watch, no hit.
    const b = buildRule();
    const first = b.detect(fail(0, 0));
    const second = b.detect(fail(1, 10));
    expect(first[0]?.isPartial).toBe(true);
    expect(second[0]?.isPartial).toBe(true);
    expect([...first, ...second].filter((f) => f.isPartial !== true)).toHaveLength(0);
  });
});
