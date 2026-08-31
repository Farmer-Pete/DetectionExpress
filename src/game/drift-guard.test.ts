import { describe, expect, it } from "vitest";
import catalogue from "../../docs/world/scenarios.json";
import { isRawKioskV1 } from "../sim/endpoints/kiosk/formats/kiosk-v1";
import type { DetectView } from "../sim/finding";
import { reasonOf } from "../sim/reason-of";
import { buildEngine, scenarioRegistry } from "./registry";
import { LEVEL_SEED } from "./tuning";

/**
 * The drift guard (GH42-PLAN.md "test seams" #8). Four invariants the ticket's
 * single-scenario proof must hold so a future scenario folder can join safely:
 *
 * 1. Every catalogue id maps to a registered scenario, or sits on this explicit
 *    "not built yet" allowlist. Update this list, by hand, the moment a new
 *    scenario folder is registered — that is the point of an explicit list
 *    instead of "whatever's left over."
 * 2. Every registered scenario has a catalogue entry (already enforced by
 *    `composeRegistry` at load; asserted again here for a direct failure).
 * 3. Every registered scenario's engine rule id equals its own scenario id.
 * 4. The reason mapping holds: a catalogue id maps to its alert reason through
 *    the documented `reasonOf` transform (hyphen -> underscore), and the live
 *    engine actually raises that reason.
 */

/** The 29 catalogue hunts this ticket does not build. GH42-PLAN.md's own count. */
const NOT_BUILT_YET = [
  "rapid-fire-tap",
  "revoked-pass",
  "propped-gate",
  "night-shift",
  "rattling-the-lock",
  "network-sweep",
  "number-fishing",
  "cashback-loop",
  "master-key-sweep",
  "knock-flood",
  "broken-seal",
  "freight-run",
  "broken-journey",
  "short-change-journey",
  "two-platforms-at-once",
  "lazarus-card",
  "skipped-checkpoint",
  "ghost-train",
  "rolling-clone",
  "wormhole-transfer",
  "shadow-rider",
  "quiet-handover",
  "roaming-badge",
  "metronome",
  "phantom-signal",
  "runaway-cadence",
  "convergence-on-control",
  "dispatcher-overreach",
  "ghost-crowd",
];

const catalogueIds = catalogue.scenarios.map((s) => s.id);
const registeredIds = scenarioRegistry.map((e) => e.id);

describe("drift guard: catalogue vs. registry", () => {
  it("carries exactly one allowlist entry per not-built catalogue id, no more, no less", () => {
    // Every allowlist id must be a real catalogue id (a stale entry would hide a
    // renamed or removed hunt from this guard).
    for (const id of NOT_BUILT_YET) {
      expect(catalogueIds).toContain(id);
    }
    expect(new Set(NOT_BUILT_YET).size).toBe(NOT_BUILT_YET.length);
  });

  it("maps every catalogue id to a registered scenario or the not-built-yet allowlist", () => {
    for (const id of catalogueIds) {
      const registered = registeredIds.includes(id);
      const allowlisted = NOT_BUILT_YET.includes(id);
      expect(
        registered || allowlisted,
        `catalogue id "${id}" is neither registered nor on the not-built-yet allowlist`,
      ).toBe(true);
      expect(
        registered && allowlisted,
        `catalogue id "${id}" is both registered AND on the not-built-yet allowlist`,
      ).toBe(false);
    }
  });

  it("gives every registered scenario a catalogue entry", () => {
    for (const id of registeredIds) {
      expect(catalogueIds, `registered scenario "${id}" has no catalogue entry`).toContain(id);
    }
  });
});

describe("drift guard: engine rule id vs. scenario id", () => {
  it("builds every registered scenario's rule with an id equal to its own scenario id", () => {
    for (const entry of scenarioRegistry) {
      const rule = entry.buildRule();
      expect(rule.id, `scenario "${entry.id}" builds a rule id of "${rule.id}"`).toBe(entry.id);
    }
  });
});

describe("drift guard: the reasonOf mapping", () => {
  it("maps the hyphenated hunt id to its underscored alert reason", () => {
    expect(reasonOf("pin-brute-force")).toBe("pin_brute_force");
  });

  it("holds for every registered scenario id (hyphen -> underscore, nothing else)", () => {
    for (const id of registeredIds) {
      expect(reasonOf(id)).toBe(id.replaceAll("-", "_"));
    }
  });

  it("matches the reason the live composed engine actually raises for pin-brute-force", () => {
    const entry = scenarioRegistry.find((e) => e.id === "pin-brute-force");
    expect(entry).toBeDefined();
    if (!entry) {
      return;
    }
    const { events } = entry.scenario.generate(LEVEL_SEED);
    const engine = buildEngine();
    const reasons = new Set<string>();
    for (const ev of events) {
      if (!isRawKioskV1(ev.payload)) {
        throw new Error("expected a kiosk-v1 payload");
      }
      const norm = engine.normalize(ev.payload, ev.endpoint);
      const view: DetectView = { ...norm, id: ev.id, ts: ev.ts, endpoint: ev.endpoint };
      for (const finding of engine.detect(view)) {
        reasons.add(finding.alert.reason);
      }
      if (reasons.size > 0) {
        break; // one confirmed reason is enough; the run scores 100 elsewhere
      }
    }
    expect(reasons.size).toBeGreaterThan(0);
    expect([...reasons]).toEqual([reasonOf(entry.id)]);
  });
});
