import { describe, expect, it } from "vitest";
import type { Alert } from "../../sim/finding";
import type { EngineFields } from "../../sim/tasks";
import type { LoadedAlgorithm } from "../algorithm";
import { adaptLoaded, parseRequest } from "./worker-support";

/**
 * The worker's real logic, kept pure so it is unit-tested without a live worker:
 * parse the inbound request, and adapt a loaded (untyped) player module into the
 * rule the calibrator prices, parsing its returns at the boundary with the SAME
 * helpers the run-time Match task uses. See GH3-PLAN.md section 6.5.
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

/** A flat Match view: the engine fields plus the normalized kiosk fields a rule reads. */
interface KioskFlatView extends EngineFields {
  account: string;
  terminal: string;
  outcome: "success" | "fail";
}
function view(): KioskFlatView {
  return {
    account: "amy",
    terminal: "KIOSK-01",
    outcome: "fail",
    id: 1,
    ts: 5,
    endpoint: "kiosk-v1",
  };
}

describe("adaptLoaded", () => {
  const loaded: LoadedAlgorithm = {
    normalize: () => ({ account: "amy", terminal: "KIOSK-01", outcome: "fail" }),
    match: (v) =>
      v instanceof Object ? { reason: "pin_brute_force", at: 5, eventIds: [1] } : null,
  };

  it("passes the normalize result through as a plain object", () => {
    const rule = adaptLoaded(loaded);
    expect(rule.normalize({ t: 1, acct: "x", term: "y", res: "WRONG_PIN" })).toEqual({
      account: "amy",
      terminal: "KIOSK-01",
      outcome: "fail",
    });
  });

  it("parses the match result into an Alert", () => {
    const rule = adaptLoaded(loaded);
    expect(rule.match(view())).toEqual({ reason: "pin_brute_force", at: 5, eventIds: [1] });
  });

  it("accepts an array of Alerts, like the run-time Match task (M2 review)", () => {
    const alerts: Alert[] = [
      { reason: "pin_brute_force", at: 5, eventIds: [1] },
      { reason: "pin_brute_force", at: 6, eventIds: [2] },
    ];
    const arrayRule: LoadedAlgorithm = { normalize: (raw) => raw, match: () => alerts };
    const rule = adaptLoaded(arrayRule);
    expect(() => rule.match(view())).not.toThrow();
    expect(rule.match(view())).toEqual(alerts);
  });

  it("throws when normalize returns a non-object", () => {
    const bad: LoadedAlgorithm = { normalize: () => 42, match: () => null };
    expect(() => adaptLoaded(bad).normalize({ t: 1, acct: "x", term: "y", res: "OK" })).toThrow();
  });
});
