import { describe, expect, it } from "bun:test";
import { measurementBlock } from "./guard";

/**
 * The profiler defers, never rejects, when its timers are unusable. A hidden tab
 * throttles the worker's clock, so a reading taken then is meaningless and the
 * measurement waits for focus. A machine merely running faster or slower is fine:
 * that cancels in the C/A ratio, so it is never a reason to block.
 * See GH3-PLAN.md section 7.
 */
describe("measurementBlock", () => {
  it("blocks with no-timer when there is no high-resolution clock", () => {
    expect(measurementBlock(false, false)).toBe("no-timer");
  });

  it("defers while the tab is hidden", () => {
    expect(measurementBlock(true, true)).toBe("hidden");
  });

  it("allows the reading when the tab is visible and a clock exists", () => {
    expect(measurementBlock(false, true)).toBeNull();
  });

  it("reports the missing timer even while hidden, since it cannot measure at all", () => {
    expect(measurementBlock(true, false)).toBe("no-timer");
  });
});
