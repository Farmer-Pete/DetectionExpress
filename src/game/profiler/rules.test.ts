import { describe, expect, it } from "vitest";
import { PIN_BRUTE_FORCE_THRESHOLD } from "../tuning";
import {
  type Detector,
  type KioskDetectView,
  makeIncrementalTally,
  makeNaiveScan,
  normalizeKiosk,
  SCAN_WINDOW_S,
} from "./rules";

/**
 * The two detection rules the profiler and the M2 game share: the naive raw-log
 * scan (the slow default) and the incremental tally (the Optimization). Both must
 * agree on the ground truth so the profiler is timing the same detector, just at
 * different speeds. See GH3-PLAN.md sections 6.5 and 9, M1 seam 3.
 */

/** A fail Event on an account at a game-second time, in the flat detect view. */
function fail(account: string, ts: number, id: number): KioskDetectView {
  return { account, terminal: "KIOSK-01", outcome: "fail", id, ts, endpoint: "kiosk-v1" };
}

/** Feed a detector a whole stream and collect the times it raised a finding. */
function fireTimes(detector: Detector, stream: KioskDetectView[]): number[] {
  const fires: number[] = [];
  for (const event of stream) {
    for (const finding of detector.step(event)) {
      fires.push(finding.alert.at);
    }
  }
  return fires;
}

describe("normalizeKiosk", () => {
  it("maps the terse wire fields onto the domain shape", () => {
    expect(normalizeKiosk({ t: 5, acct: "amy", term: "KIOSK-09", res: "WRONG_PIN" })).toEqual({
      account: "amy",
      terminal: "KIOSK-09",
      outcome: "fail",
    });
    expect(normalizeKiosk({ t: 5, acct: "amy", term: "KIOSK-09", res: "OK" }).outcome).toBe(
      "success",
    );
  });
});

describe.each([
  ["naive scan", makeNaiveScan],
  ["incremental tally", makeIncrementalTally],
])("%s", (_name, make) => {
  it("raises one Alert when the threshold is crossed inside the window", () => {
    const stream = Array.from({ length: PIN_BRUTE_FORCE_THRESHOLD }, (_, i) =>
      fail("amy", i * 10, i),
    );
    const fires = fireTimes(make(), stream);
    expect(fires.length).toBe(1);
    expect(fires[0]).toBe((PIN_BRUTE_FORCE_THRESHOLD - 1) * 10);
  });

  it("carries a bare anchor that is a member of eventIds, and no subjectType", () => {
    const stream = Array.from({ length: PIN_BRUTE_FORCE_THRESHOLD }, (_, i) =>
      fail("amy", i * 10, i),
    );
    const detector = make();
    const findings = stream.flatMap((event) => detector.step(event));
    expect(findings).toHaveLength(1);
    const finding = findings[0];
    // The profiler panel never reads these, so they anchor only, no grouping key.
    expect(finding?.eventId).toBeDefined();
    expect(finding?.subjectType).toBeUndefined();
    expect(finding?.alert.eventIds).toContain(finding?.eventId);
  });

  it("stays silent while failures sit below the threshold", () => {
    const stream = Array.from({ length: PIN_BRUTE_FORCE_THRESHOLD - 1 }, (_, i) =>
      fail("amy", i * 10, i),
    );
    expect(fireTimes(make(), stream)).toEqual([]);
  });

  it("does not fire when the failures straddle more than one window", () => {
    // Four fails, then a fifth a full window later: never five inside one window.
    const stream = [
      fail("amy", 0, 0),
      fail("amy", 10, 1),
      fail("amy", 20, 2),
      fail("amy", 30, 3),
      fail("amy", 40 + SCAN_WINDOW_S, 4),
    ];
    expect(fireTimes(make(), stream)).toEqual([]);
  });

  it("ignores successes and keeps its retained state bounded to the window", () => {
    const detector = make();
    for (let i = 0; i < 200; i++) {
      detector.step({
        account: "amy",
        terminal: "KIOSK-01",
        outcome: "success",
        id: i,
        ts: i * 10,
        endpoint: "kiosk-v1",
      });
    }
    expect(detector.retained()).toBe(0);
  });
});
