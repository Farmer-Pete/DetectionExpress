import { describe, expect, it } from "vitest";
import type { Finding } from "../../sim/finding";
import type { EngineFields } from "../../sim/tasks";
import type { LoadedAlgorithm } from "../algorithm";
import { adaptLoaded, parseRequest } from "./worker-support";

/**
 * The worker's real logic, kept pure so it is unit-tested without a live worker:
 * parse the inbound request, and adapt a loaded (untyped) player module into the
 * rule the calibrator prices, parsing its returns at the boundary with the SAME
 * helpers the run-time Detect task uses. See GH3-PLAN.md section 6.5.
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
      target: { kind: "source", source: "export const detect = () => []" },
      hidden: true,
    };
    expect(parseRequest(request)).toEqual({
      target: { kind: "source", source: "export const detect = () => []" },
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

/** A flat Detect view: the engine fields plus the normalized kiosk fields a rule reads. */
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
    detect: (v) =>
      v instanceof Object ? [{ alert: { reason: "pin_brute_force", at: 5, eventIds: [1] } }] : [],
  };

  it("passes the normalize result through as a plain object", () => {
    const rule = adaptLoaded(loaded);
    expect(rule.normalize({ t: 1, acct: "x", term: "y", res: "WRONG_PIN" })).toEqual({
      account: "amy",
      terminal: "KIOSK-01",
      outcome: "fail",
    });
  });

  it("parses the detect result into findings", () => {
    const rule = adaptLoaded(loaded);
    expect(rule.detect(view())).toEqual([
      { alert: { reason: "pin_brute_force", at: 5, eventIds: [1] } },
    ]);
  });

  it("accepts multiple findings, like the run-time Detect task (M2 review)", () => {
    const findings: Finding[] = [
      { alert: { reason: "pin_brute_force", at: 5, eventIds: [1] } },
      { alert: { reason: "pin_brute_force", at: 6, eventIds: [2] } },
    ];
    const arrayRule: LoadedAlgorithm = { normalize: (raw) => raw, detect: () => findings };
    const rule = adaptLoaded(arrayRule);
    expect(() => rule.detect(view())).not.toThrow();
    expect(rule.detect(view())).toEqual(findings);
  });

  it("throws when normalize returns a non-object", () => {
    const bad: LoadedAlgorithm = { normalize: () => 42, detect: () => [] };
    expect(() => adaptLoaded(bad).normalize({ t: 1, acct: "x", term: "y", res: "OK" })).toThrow();
  });
});
