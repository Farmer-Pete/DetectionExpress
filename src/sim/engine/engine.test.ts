import { describe, expect, it } from "vitest";
import type { DetectView, Finding } from "../finding";
import { type BuildRule, createEngine, type EngineRule, type Normalizer } from "./engine";

/** A fixture normalizer that tags the raw with which endpoint parsed it. */
function tagNormalizer(endpoint: string): Normalizer {
  return (raw) => ({ parsedBy: endpoint, raw });
}

/** A fixture rule factory: counts the events it sees per entity in fresh state. */
function countingRule(id: string, endpoints: string[]): BuildRule {
  return (): EngineRule => {
    let seen = 0;
    return {
      id,
      endpoints,
      detect(e: DetectView): Finding[] {
        seen += 1;
        return [
          {
            alert: { reason: id, at: e.ts, eventIds: [e.id] },
            eventId: e.id,
            context: [{ type: "text", text: `${seen}` }],
          },
        ];
      },
    };
  };
}

function view(id: number, endpoint: string): DetectView {
  return { id, ts: id, endpoint };
}

describe("createEngine normalize dispatch", () => {
  it("dispatches to the normalizer registered for the endpoint", () => {
    const engine = createEngine({
      normalizers: {
        "kiosk-v1": tagNormalizer("kiosk-v1"),
        "fare-gate": tagNormalizer("fare-gate"),
      },
      rules: [],
    });
    expect(engine.normalize({ x: 1 }, "kiosk-v1")).toEqual({ parsedBy: "kiosk-v1", raw: { x: 1 } });
    expect(engine.normalize({ y: 2 }, "fare-gate")).toEqual({
      parsedBy: "fare-gate",
      raw: { y: 2 },
    });
  });

  it("throws on an endpoint with no registered normalizer", () => {
    const engine = createEngine({
      normalizers: { "kiosk-v1": tagNormalizer("kiosk-v1") },
      rules: [],
    });
    expect(() => engine.normalize({}, "unknown")).toThrow(/no normalizer/i);
  });
});

describe("createEngine detect routing", () => {
  it("routes each event only to the rules that own its endpoint", () => {
    const engine = createEngine({
      normalizers: {},
      rules: [countingRule("kiosk-rule", ["kiosk-v1"]), countingRule("gate-rule", ["fare-gate"])],
    });
    const kiosk = engine.detect(view(1, "kiosk-v1"));
    expect(kiosk.map((f) => f.alert.reason)).toEqual(["kiosk-rule"]);
    const gate = engine.detect(view(2, "fare-gate"));
    expect(gate.map((f) => f.alert.reason)).toEqual(["gate-rule"]);
  });

  it("fans one event out to every rule that lists its endpoint", () => {
    const engine = createEngine({
      normalizers: {},
      rules: [countingRule("a", ["kiosk-v1"]), countingRule("b", ["kiosk-v1", "fare-gate"])],
    });
    const findings = engine.detect(view(1, "kiosk-v1"));
    expect(findings.map((f) => f.alert.reason).sort()).toEqual(["a", "b"]);
  });

  it("keeps each rule's state independent across two engine instances", () => {
    const config = { normalizers: {}, rules: [countingRule("k", ["kiosk-v1"])] };
    const engineA = createEngine(config);
    const engineB = createEngine(config);

    engineA.detect(view(1, "kiosk-v1"));
    engineA.detect(view(2, "kiosk-v1"));
    const aThird = engineA.detect(view(3, "kiosk-v1"))[0];
    // Engine B starts clean: its rule's `seen` counter is 1 on its first event, not 3.
    const bFirst = engineB.detect(view(9, "kiosk-v1"))[0];

    expect(aThird?.context).toEqual([{ type: "text", text: "3" }]);
    expect(bFirst?.context).toEqual([{ type: "text", text: "1" }]);
  });
});
