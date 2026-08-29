import { describe, expect, it } from "vitest";
import { makeAnchor } from "./anchor";
import type { MatchView } from "./rules";

/**
 * The anchor is the difficulty baseline: a fixed, array-and-garbage-shaped scan
 * over the corpus, the same shape as the naive rule. Timing it gives A, the
 * machine's throughput on detection-shaped work, which normalizes the player's C
 * into the machine-independent C/A. It is frozen: it never tracks whatever rule
 * ships. See GH3-PLAN.md section 7.
 */
function fail(account: string, ts: number, id: number): MatchView {
  return { account, terminal: "KIOSK-01", outcome: "fail", id, ts, endpoint: "kiosk-v1" };
}

describe("makeAnchor", () => {
  it("does per-fail scan work and returns a running, consumable checksum", () => {
    const anchor = makeAnchor();
    const first = anchor(fail("amy", 0, 0));
    const second = anchor(fail("amy", 10, 1));
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(first);
  });

  it("ignores successes, so only detection-shaped work is timed", () => {
    const anchor = makeAnchor();
    const before = anchor(fail("amy", 0, 0));
    const after = anchor({
      account: "amy",
      terminal: "KIOSK-01",
      outcome: "success",
      id: 1,
      ts: 10,
      endpoint: "kiosk-v1",
    });
    expect(after).toBe(before);
  });

  it("is deterministic: the same stream yields the same checksum", () => {
    const stream = [fail("amy", 0, 0), fail("bob", 5, 1), fail("amy", 10, 2)];
    const run = (): number => {
      const anchor = makeAnchor();
      let last = 0;
      for (const event of stream) {
        last = anchor(event);
      }
      return last;
    };
    expect(run()).toBe(run());
  });
});
