import { describe, expect, it } from "vitest";
import type { Alert } from "../../sim/alert";
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
  it("accepts a well-formed url-target request", () => {
    const request = { target: { kind: "url", url: "src/algorithms/kiosk.ts?v=2" }, hidden: false };
    expect(parseRequest(request)).toEqual({
      target: { kind: "url", url: "src/algorithms/kiosk.ts?v=2" },
      hidden: false,
    });
  });

  it("accepts a well-formed source-target request", () => {
    const request = {
      target: { kind: "source", source: "export const match = () => null" },
      hidden: true,
    };
    expect(parseRequest(request)).toEqual({
      target: { kind: "source", source: "export const match = () => null" },
      hidden: true,
    });
  });

  it("rejects a request missing or malformed in its fields", () => {
    expect(() => parseRequest({ target: { kind: "url", url: 42 }, hidden: false })).toThrow();
    expect(() => parseRequest({ target: { kind: "source" }, hidden: false })).toThrow();
    expect(() => parseRequest({ target: { kind: "bogus" }, hidden: false })).toThrow();
    expect(() => parseRequest({ source: "x", hidden: false })).toThrow(); // the old flat shape
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
    match: (v) => (v instanceof Object ? { reason: "pin_brute_force", at: 5, events: [1] } : null),
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
    expect(rule.match(view())).toEqual({ reason: "pin_brute_force", at: 5, events: [1] });
  });

  it("accepts an array of Alerts, like the run-time Match task (M2 review)", () => {
    const alerts: Alert[] = [
      { reason: "pin_brute_force", at: 5, events: [1] },
      { reason: "pin_brute_force", at: 6, events: [2] },
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
