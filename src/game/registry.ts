/**
 * The scenario registry: the one place the many parallel scenario folders and the
 * endpoint normalizers are gathered and composed into the single engine. It globs
 * each scenario's `index.ts` (the UI reads `scenario`, the engine reads `buildRule`,
 * the profiler reads `corpus`), globs each endpoint's normalizer, joins every code
 * scenario to its `docs/world/scenarios.json` entry by id, and calls `createEngine`.
 *
 * The glob lives here in `game/`, never in `sim/`, so `sim/` stays free of bundler
 * coupling (ARCHITECTURE). Validation happens at this seam: a scenario module missing
 * its parts, a duplicate scenario id, or a code scenario with no catalogue match all
 * throw at load, so a malformed folder fails loudly instead of silently dropping out.
 */

import catalogue from "../../docs/world/scenarios.json";
import { type BuildRule, createEngine, type Engine, type Normalizer } from "../sim/engine/engine";
import type { Scenario } from "../sim/scenario";

/** One catalogue entry, as the display join reads it. Loose: `docs/world` owns the schema. */
export interface CatalogueEntry {
  id: string;
  name: string;
  difficulty: { stars: number; label: string; shape: string };
  sensors: string[];
  flavor: { tagline: string; intro: string };
  // `mitre` is absent on some catalogue entries, so it stays optional here.
  security: { realWorldConcept: string; briefing: string; mitre?: string[] };
}

/** A code scenario joined to its catalogue metadata by id. */
export interface ScenarioRegistryEntry {
  /** The scenario id, e.g. "pin-brute-force". */
  id: string;
  /** The sim Scenario: stream + ground truth, read by the UI and the run controller. */
  scenario: Scenario;
  /** The rule factory the engine gathers. */
  buildRule: BuildRule;
  /** The catalogue metadata joined by id: display name, difficulty, briefing. */
  catalogue: CatalogueEntry;
}

/** The exports a scenario `index.ts` must carry. Validated at the glob seam. */
export interface ScenarioModule {
  scenario?: unknown;
  buildRule?: unknown;
}

/** The exports an endpoint `normalize.ts` carries. */
export interface NormalizerModule {
  normalizers?: Record<string, Normalizer>;
}

const scenarioModules = import.meta.glob<ScenarioModule>("../sim/scenarios/*/index.ts", {
  eager: true,
});
const normalizerModules = import.meta.glob<NormalizerModule>("../sim/endpoints/*/normalize.ts", {
  eager: true,
});

/** Index the catalogue by id, so each join is a lookup. Pure, so tests inject their own. */
export function indexCatalogue(entries: readonly CatalogueEntry[]): Map<string, CatalogueEntry> {
  return new Map(entries.map((entry) => [entry.id, entry]));
}

/** A string primitive, by its tag rather than a `typeof` representation check. */
function isString(value: unknown): value is string {
  return !(value instanceof Object) && Object.prototype.toString.call(value) === "[object String]";
}

/** Is `value` a usable Scenario (has a string id and a `generate`)? */
function isScenario(value: unknown): value is Scenario {
  return (
    value instanceof Object &&
    "id" in value &&
    isString(value.id) &&
    "generate" in value &&
    value.generate instanceof Function
  );
}

/** Is `value` a rule factory? A zero-arg function that yields an `EngineRule`. */
function isBuildRule(value: unknown): value is BuildRule {
  return value instanceof Function;
}

/**
 * Gather and join scenario modules, validating each at the seam: a module missing its
 * `scenario`/`buildRule`, a duplicate scenario id, or an id with no catalogue entry all
 * throw. Pure over its inputs, so the failure paths are unit-tested without the glob.
 */
export function composeRegistry(
  modules: Record<string, ScenarioModule>,
  catalogueById: Map<string, CatalogueEntry>,
): ScenarioRegistryEntry[] {
  const entries: ScenarioRegistryEntry[] = [];
  const seen = new Set<string>();

  for (const [path, mod] of Object.entries(modules)) {
    if (!isScenario(mod.scenario)) {
      throw new Error(`Scenario module "${path}" does not export a valid \`scenario\`.`);
    }
    if (!isBuildRule(mod.buildRule)) {
      throw new Error(`Scenario module "${path}" does not export a \`buildRule\` factory.`);
    }
    const id = mod.scenario.id;
    if (seen.has(id)) {
      throw new Error(`Duplicate scenario id "${id}" (from "${path}").`);
    }
    seen.add(id);
    const catalogueEntry = catalogueById.get(id);
    if (catalogueEntry === undefined) {
      throw new Error(`Scenario "${id}" (from "${path}") has no matching catalogue entry.`);
    }
    entries.push({
      id,
      scenario: mod.scenario,
      buildRule: mod.buildRule,
      catalogue: catalogueEntry,
    });
  }

  entries.sort((a, b) => a.id.localeCompare(b.id));
  return entries;
}

/** Gather every endpoint's normalizers into one map keyed by endpoint id. Pure. */
export function mergeNormalizers(
  modules: Record<string, NormalizerModule>,
): Record<string, Normalizer> {
  const merged: Record<string, Normalizer> = {};
  for (const [path, mod] of Object.entries(modules)) {
    if (mod.normalizers === undefined) {
      throw new Error(`Endpoint module "${path}" does not export \`normalizers\`.`);
    }
    for (const [endpoint, normalizer] of Object.entries(mod.normalizers)) {
      if (merged[endpoint] !== undefined) {
        throw new Error(`Two endpoints registered a normalizer for "${endpoint}".`);
      }
      merged[endpoint] = normalizer;
    }
  }
  return merged;
}

/** The registered scenarios, joined to their catalogue metadata, sorted by id. */
const catalogueScenarios: readonly CatalogueEntry[] = catalogue.scenarios;
export const scenarioRegistry: ScenarioRegistryEntry[] = composeRegistry(
  scenarioModules,
  indexCatalogue(catalogueScenarios),
);

/** The endpoint normalizers the engine dispatches on, keyed by endpoint id. */
const normalizers: Record<string, Normalizer> = mergeNormalizers(normalizerModules);

/**
 * Compose a fresh single engine from the whole registry: the gathered normalizers and
 * every scenario's rule factory. Fresh per call, so each run owns clean rule state.
 */
export function buildEngine(): Engine {
  return createEngine({
    normalizers,
    rules: scenarioRegistry.map((entry) => entry.buildRule),
  });
}

/** Look up a registered scenario entry by id, or undefined. */
export function scenarioEntry(id: string): ScenarioRegistryEntry | undefined {
  return scenarioRegistry.find((entry) => entry.id === id);
}

/** The scenario the app shows today. The registry always has at least one entry. */
const firstEntry = scenarioRegistry[0];
if (firstEntry === undefined) {
  throw new Error("The scenario registry is empty; no scenario folder was found.");
}

/** The first registered sim Scenario. The app and its run controller consume this. */
export const defaultScenario: Scenario = firstEntry.scenario;

/**
 * The first registered entry, catalogue metadata and all. UI content that needs
 * more than the bare Scenario (a display name, a tagline) reads this, rather than
 * hardcoding its own copy of what the registry already joined.
 */
export const defaultEntry: ScenarioRegistryEntry = firstEntry;
