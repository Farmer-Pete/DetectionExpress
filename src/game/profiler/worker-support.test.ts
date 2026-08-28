import { describe, expect, it } from "bun:test";
import type { LoadedAlgorithm } from "../algorithm";
import { adaptLoaded, parseRequest } from "./worker-support";

/**
 * The worker's real logic, kept pure so it is unit-tested without a live worker:
 * parse the inbound request, and adapt a loaded (untyped) player module into the
 * typed ProfilerRule the calibrator prices, parsing its returns at the boundary.
 * See GH3-PLAN.md section 6.5.
 */
describe("parseRequest", () => {
  it("accepts a well-formed profile request", () => {
    expect(parseRequest({ source: "export const match = () => null", hidden: false })).toEqual({
      source: "export const match = () => null",
      hidden: false,
    });
  });

  it("rejects a request missing its fields", () => {
    expect(() => parseRequest({ source: 42, hidden: false })).toThrow();
    expect(() => parseRequest(null)).toThrow();
  });
});

describe("adaptLoaded", () => {
  const loaded: LoadedAlgorithm = {
    normalize: () => ({ account: "amy", terminal: "KIOSK-01", outcome: "fail" }),
    match: (view) =>
      view instanceof Object ? { reason: "pin_brute_force", at: 5, events: [1] } : null,
  };

  it("parses the normalize result into the domain shape", () => {
    const rule = adaptLoaded(loaded);
    expect(rule.normalize({ t: 1, acct: "x", term: "y", res: "WRONG_PIN" })).toEqual({
      account: "amy",
      terminal: "KIOSK-01",
      outcome: "fail",
    });
  });

  it("parses the match result into an Alert", () => {
    const rule = adaptLoaded(loaded);
    const alert = rule.match({
      account: "amy",
      terminal: "KIOSK-01",
      outcome: "fail",
      id: 1,
      ts: 5,
      endpoint: "kiosk-v1",
    });
    expect(alert).toEqual({ reason: "pin_brute_force", at: 5, events: [1] });
  });

  it("throws when normalize returns the wrong shape", () => {
    const bad: LoadedAlgorithm = { normalize: () => 42, match: () => null };
    expect(() => adaptLoaded(bad).normalize({ t: 1, acct: "x", term: "y", res: "OK" })).toThrow();
  });
});
