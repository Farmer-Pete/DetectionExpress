/**
 * The single detection engine. One engine detects every hunt, authored as many
 * files: a core (`core.ts`), one endpoint normalizer per wire format, and one rule
 * factory per scenario. `createEngine` composes them into `{ normalize, detect }`.
 *
 * `normalize(raw, endpoint)` dispatches to the endpoint's normalizer, so one engine
 * parses many wire formats. `detect(e)` routes each normalized Event to every rule
 * whose `endpoints` include `e.endpoint`, so many rules share one stream without
 * cross-contaminating.
 *
 * Rules are FACTORIES (`buildRule`). `createEngine` builds each rule once, at
 * construction, so every engine instance owns fresh per-rule state and two engines
 * never leak into each other. That is what lets the run controller replay a run
 * cleanly and the profiler measure an isolated copy.
 *
 * Pure logic: no React, no bundler globs. The registry (in `game/`) gathers the
 * normalizers and factories and calls this; `sim/` stays free of the glob.
 */
import type { DetectView, Finding } from "../finding";

/** One endpoint's normalizer: a raw wire payload in, a plain normalized object out. */
export type Normalizer = (raw: unknown) => object;

/**
 * A rule as the engine holds it: its hunt id, the endpoints it reads, and its
 * `detect`. Built by a `buildRule()` factory so each instance owns fresh state.
 */
export interface EngineRule {
  /** The hunt id, e.g. "pin-brute-force". The drift guard keys on it. */
  id: string;
  /** One or more endpoint ids this rule reads. Supports multi-sensor hunts. */
  endpoints: string[];
  /** Run the rule on one normalized Event view. Fresh state per built rule. */
  detect(e: DetectView): Finding[];
}

/** A rule factory: one call yields one `EngineRule` with fresh state. */
export type BuildRule = () => EngineRule;

/** What `createEngine` composes: the normalizers keyed by endpoint id, and the factories. */
export interface EngineConfig {
  /** Endpoint id -> its normalizer. `normalize` dispatches on this map. */
  normalizers: Record<string, Normalizer>;
  /** The rule factories the registry gathered. Each is built once here. */
  rules: BuildRule[];
}

/** The composed engine: the two callables the run controller and profiler drive. */
export interface Engine {
  /** Parse a raw wire payload for `endpoint` into its normalized object. */
  normalize(raw: unknown, endpoint: string): object;
  /** Route a normalized Event view to every rule that owns its endpoint. */
  detect(e: DetectView): Finding[];
}

/**
 * Compose the engine from its normalizers and rule factories. Each factory is
 * built once here, so this engine instance owns fresh per-rule state.
 */
export function createEngine(config: EngineConfig): Engine {
  const rules = config.rules.map((build) => build());
  return {
    normalize(raw, endpoint) {
      const normalizer = config.normalizers[endpoint];
      if (normalizer === undefined) {
        throw new Error(`No normalizer is registered for endpoint "${endpoint}".`);
      }
      return normalizer(raw);
    },
    detect(e) {
      const findings: Finding[] = [];
      for (const rule of rules) {
        if (rule.endpoints.includes(e.endpoint)) {
          findings.push(...rule.detect(e));
        }
      }
      return findings;
    },
  };
}
