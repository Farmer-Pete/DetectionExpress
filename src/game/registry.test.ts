import { describe, expect, it } from "vitest";
import { createScorer } from "../sim/correctness";
import { isRawKioskV1 } from "../sim/endpoints/kiosk/formats/kiosk-v1";
import type { DetectView } from "../sim/finding";
import {
  buildEngine,
  type CatalogueEntry,
  composeRegistry,
  indexCatalogue,
  mergeNormalizers,
  scenarioEntry,
  scenarioRegistry,
} from "./registry";
import { CORRECTNESS_W_FN, CORRECTNESS_W_FP, CORRECTNESS_WINDOW, LEVEL_SEED } from "./tuning";

describe("scenario registry contents", () => {
  it("registers pin-brute-force joined to its catalogue name and briefing", () => {
    const entry = scenarioEntry("pin-brute-force");
    expect(entry).toBeDefined();
    expect(entry?.scenario.id).toBe("pin-brute-force");
    expect(entry?.catalogue.name).toBe("PIN Brute Force");
    expect(entry?.catalogue.security.briefing.length).toBeGreaterThan(0);
    expect(entry?.buildRule).toBeInstanceOf(Function);
  });

  it("exposes exactly the scenarios that ship today", () => {
    expect(scenarioRegistry.map((e) => e.id)).toEqual(["pin-brute-force"]);
  });
});

describe("the registry-composed engine", () => {
  it("scores 100 on pin-brute-force through createScorer", () => {
    const entry = scenarioEntry("pin-brute-force");
    if (!entry) {
      throw new Error("pin-brute-force is not registered");
    }
    const { events, attacks } = entry.scenario.generate(LEVEL_SEED);
    const engine = buildEngine();
    const scorer = createScorer(attacks, {
      window: CORRECTNESS_WINDOW,
      wFn: CORRECTNESS_W_FN,
      wFp: CORRECTNESS_W_FP,
    });

    for (const ev of events) {
      if (!isRawKioskV1(ev.payload)) {
        throw new Error("expected a kiosk-v1 payload");
      }
      const norm = engine.normalize(ev.payload, ev.endpoint);
      const view: DetectView = { ...norm, id: ev.id, ts: ev.ts, endpoint: ev.endpoint };
      const scored = engine.detect(view).map((finding) => ({ finding }));
      scorer.record(scored, ev);
    }
    scorer.finalize();

    const reading = scorer.reading();
    expect(reading.caught).toBe(attacks.length);
    expect(reading.missed).toBe(0);
    expect(reading.falseAlerts).toBe(0);
    expect(reading.rolling).toBe(100);
  });
});

/** A minimal valid catalogue entry for the pure-composition tests. */
function catalogueEntry(id: string): CatalogueEntry {
  return {
    id,
    name: id,
    difficulty: { stars: 1, label: "Rookie", shape: "" },
    sensors: [],
    flavor: { tagline: "", intro: "" },
    security: { realWorldConcept: "", briefing: "b", mitre: [] },
  };
}

/** A rule factory that builds a shape-valid `EngineRule`, for the pure-composition tests. */
function goodBuildRule() {
  return { id: "x", endpoints: ["e"], detect: () => [] };
}

const goodModule = {
  scenario: { id: "x", generate: () => ({}) },
  buildRule: goodBuildRule,
  corpus: {},
};

describe("composeRegistry validation", () => {
  it("rejects a module with no valid scenario", () => {
    expect(() =>
      composeRegistry(
        { "./a": { buildRule: goodBuildRule, corpus: {} } },
        indexCatalogue([catalogueEntry("x")]),
      ),
    ).toThrow(/valid `scenario`/);
  });

  it("rejects a module with no buildRule factory", () => {
    expect(() =>
      composeRegistry(
        { "./a": { scenario: { id: "x", generate: () => ({}) }, corpus: {} } },
        indexCatalogue([catalogueEntry("x")]),
      ),
    ).toThrow(/buildRule/);
  });

  it("rejects a module with no corpus export", () => {
    expect(() =>
      composeRegistry(
        { "./a": { scenario: { id: "x", generate: () => ({}) }, buildRule: goodBuildRule } },
        indexCatalogue([catalogueEntry("x")]),
      ),
    ).toThrow(/corpus/);
  });

  it("rejects a Scenario missing generate", () => {
    expect(() =>
      composeRegistry(
        { "./a": { scenario: { id: "x" }, buildRule: goodBuildRule, corpus: {} } },
        indexCatalogue([catalogueEntry("x")]),
      ),
    ).toThrow(/valid `scenario`/);
  });

  it("rejects a built rule with no id", () => {
    const badModule = {
      scenario: { id: "x", generate: () => ({}) },
      buildRule: () => ({ endpoints: ["e"], detect: () => [] }),
      corpus: {},
    };
    expect(() =>
      composeRegistry({ "./a": badModule }, indexCatalogue([catalogueEntry("x")])),
    ).toThrow(/EngineRule/);
  });

  it("rejects a built rule with empty endpoints", () => {
    const badModule = {
      scenario: { id: "x", generate: () => ({}) },
      buildRule: () => ({ id: "x", endpoints: [], detect: () => [] }),
      corpus: {},
    };
    expect(() =>
      composeRegistry({ "./a": badModule }, indexCatalogue([catalogueEntry("x")])),
    ).toThrow(/EngineRule/);
  });

  it("rejects a built rule whose detect is not a function", () => {
    const badModule = {
      scenario: { id: "x", generate: () => ({}) },
      buildRule: () => ({ id: "x", endpoints: ["e"], detect: "nope" }),
      corpus: {},
    };
    expect(() =>
      composeRegistry({ "./a": badModule }, indexCatalogue([catalogueEntry("x")])),
    ).toThrow(/EngineRule/);
  });

  it("rejects two scenarios sharing one id", () => {
    expect(() =>
      composeRegistry(
        { "./a": goodModule, "./b": goodModule },
        indexCatalogue([catalogueEntry("x")]),
      ),
    ).toThrow(/duplicate scenario id/i);
  });

  it("rejects a scenario with no catalogue entry", () => {
    expect(() => composeRegistry({ "./a": goodModule }, indexCatalogue([]))).toThrow(
      /no matching catalogue/i,
    );
  });
});

describe("indexCatalogue validation", () => {
  it("rejects two catalogue entries sharing one id, naming both", () => {
    const a = catalogueEntry("dup");
    const b = { ...catalogueEntry("dup"), name: "Second Dup" };
    expect(() => indexCatalogue([a, b])).toThrow(/dup.*Second Dup|Second Dup.*dup/i);
  });
});

describe("mergeNormalizers validation", () => {
  it("rejects a module that exports no normalizers", () => {
    expect(() => mergeNormalizers({ "./a": {} })).toThrow(/normalizers/);
  });

  it("rejects two endpoints registering the same id", () => {
    const one = { normalizers: { "kiosk-v1": () => ({}) } };
    expect(() => mergeNormalizers({ "./a": one, "./b": one })).toThrow(/registered a normalizer/i);
  });
});
