/**
 * The catalogue's leaf types: no dependency on `registry.ts` or the data module, so
 * both can depend on this file without an import cycle (GH127-PLAN.md "Import cycle").
 */

/** One catalogue entry, as the display join reads it. `registry.ts` re-exports this. */
export interface CatalogueEntry {
  readonly id: string;
  readonly name: string;
  readonly difficulty: { readonly stars: number; readonly label: string; readonly shape: string };
  readonly sensors: readonly string[];
  readonly flavor: { readonly tagline: string; readonly intro: string };
  // `mitre` is absent on some catalogue entries, so it stays optional here.
  readonly security: {
    readonly realWorldConcept: string;
    readonly briefing: string;
    readonly mitre?: readonly string[];
  };
}

/**
 * A resource link a scenario cites: further reading on the real-world concept.
 * Not exported: nothing outside `CatalogueScenario` names this shape directly.
 */
interface CatalogueResource {
  readonly title: string;
  readonly url: string;
}

/** The richer scenario shape the data carries: every `CatalogueEntry` field, plus `resources`. */
export interface CatalogueScenario extends CatalogueEntry {
  readonly resources: readonly CatalogueResource[];
}

/**
 * One rung of the difficulty scale: a star count, its label, and what it takes to
 * hunt it. Not exported: nothing outside `CatalogueData` names this shape directly.
 */
interface DifficultyRung {
  readonly stars: number;
  readonly label: string;
  readonly meaning: string;
}

/** The whole scenario catalogue: the difficulty scale plus every scenario. */
export interface CatalogueData {
  readonly difficultyScale: readonly DifficultyRung[];
  readonly scenarios: readonly CatalogueScenario[];
}
