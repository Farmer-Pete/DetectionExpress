/**
 * The headless scenario map (GH128-PLAN.md "New and changed files"). Unlike the
 * browser registry (`game/registry.ts`), which gathers scenarios through an
 * `import.meta.glob`, this map is written by hand: the headless CLI runs under
 * `tsx`, not Vite, so no bundler glob is available here. One entry today,
 * `pin-brute-force`; a new scenario adds one entry.
 */

import { normalizers as kioskNormalizers } from "../../sim/endpoints/kiosk/normalize";
import type { BuildRule, Normalizer } from "../../sim/engine/engine";
import type { Scenario } from "../../sim/scenario";
import {
  scenario as pinBruteForce,
  buildRule as pinBruteForceRule,
} from "../../sim/scenarios/pin-brute-force/index";

/** One scenario's headless ingredients: its truth generator, its rule, and its wire formats. */
export interface HeadlessScenarioEntry {
  scenario: Scenario;
  buildRule: BuildRule;
  normalizers: Record<string, Normalizer>;
}

const SCENARIOS: Readonly<Record<string, HeadlessScenarioEntry>> = {
  "pin-brute-force": {
    scenario: pinBruteForce,
    buildRule: pinBruteForceRule,
    normalizers: kioskNormalizers,
  },
};

/** Every scenario id the headless CLI supports, in listing order. */
export function supportedScenarioIds(): string[] {
  return Object.keys(SCENARIOS);
}

/** Resolve a scenario id to its ingredients. Throws, listing the supported ids, on a miss. */
export function getScenarioEntry(id: string): HeadlessScenarioEntry {
  const entry = SCENARIOS[id];
  if (entry === undefined) {
    throw new Error(
      `Unknown scenario id "${id}". Supported scenario ids: ${supportedScenarioIds().join(", ")}.`,
    );
  }
  return entry;
}
