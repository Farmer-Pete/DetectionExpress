# ADR 0010 - One engine for all hunts; scenarios are composable streams

- Status: Accepted
- Date: 2026-08-31
- Extends ADR 0009 (ship a finished engine). Revises ADR 0008 (native algorithm
  hot-reload), whose per-slug authoring model this supersedes.

## Context

ADR 0009 shipped a finished engine and framed the game as observe, then perturb.
But it still assumed a chaos ladder: levels, taken one at a time, with per-level
selection to come. The code matched that shape. `App.tsx` imports one scenario. The
default engine at `src/sim/default-engine.ts` holds one hunt's detect logic. ADR
0008 resolves a player's algorithm per slug, one file per scenario.

The target architecture moves past that. GH42 ships one composed engine with the
`pin-brute-force` rule; registering the remaining catalogue hunts and adding the
multi-scenario picker are follow-ups. Composition and observation are the intended
primary act. Editing the engine stays possible, but it is a bonus, not the path.

The old shape fights this in three places. The detect logic is welded to one
scenario and copied three times. Every new scenario would edit central files:
`App.tsx`, a slug map, a narrative singleton, and a global tuning file. And the
per-slug authoring model has no meaning when one engine answers thirty hunts.

## Decision

One engine detects all hunts. Scenarios are composable streams. Authoring is a
bonus.

- **One composed engine.** `createEngine({ normalizers, rules })` builds the engine
  from endpoint normalizers and detection rules. Each rule is
  `{ id, endpoints, detect }`, built by a factory so its state is fresh per run.
  `normalize(raw, endpoint)` dispatches by endpoint. `detect(e)` routes to every
  rule that owns the event's endpoint. So one engine reads as many wire formats as
  it has registered endpoint families and runs as many hunts as it has registered
  rules.

- **Scenarios are streams with ground truth.** A scenario folder holds its stream
  generator, its attack plan, its detection rule, and its tuning. It contributes a
  rule to the engine. It no longer owns an engine. A scenario's test asserts the
  shipped engine scores 100 on that scenario's stream.

- **Parallel authoring by discovery, not central edits.** Each scenario folder
  exports one `index.ts` of `{ scenario, buildRule, corpus }`. A registry in
  `src/game/` gathers them with `import.meta.glob` and joins each to its
  `docs/world/scenarios.json` entry by id. No central file grows with each scenario.
  The glob lives in `game/`, so `sim/` stays free of bundler magic.

- **Compose streams by merging runs.** `mergeRuns` feeds many scenarios to the
  engine at once. Every scenario shares one wave schedule, since `buildSchedule` is
  seedless, so the merge keeps one schedule rather than concatenating and overlapping
  them. Entity disjointness is set at generation through a partition index, not by
  rewriting opaque payloads. The merge renumbers event ids, remaps attack ids, and
  asserts no collision, disjoint entities, and preserved separability.

- **One authored engine source, many files.** The engine is authored as a core plus
  one rule file per scenario. For running and testing, the code imports the composed
  engine directly. For the in-game editor, an assembler type-strips those files and
  inlines the dependency graph into one readable JS module, formatted by Biome and
  served as a Vite virtual module. Nothing generated is committed.

- **Authoring is one engine, not per slug.** The engine is composed from a core plus
  one rule file per scenario, into a single editor source. A player edits that source
  in the app and presses Apply to reload it. (An earlier local-IDE override file and
  `algo:` hot-reload handshake were removed in GH118; see ADR 0008.)

## Consequences

- The three-copy parity trio collapses to one authored source. The generated editor
  string is a build artifact, not a copy.
- A new scenario is a new folder. It never edits `App.tsx`, a slug map, a narrative
  singleton, or the global tuning file.
- Scoring becomes per-attack. `Attack` carries its own threshold, so mixed hunts
  score correctly under one engine.
- The normalize seam changes: `normalize` gains the endpoint. This touches
  `src/sim/tasks.ts` and the algorithm contract.
- ADR 0008's per-slug model was already revised here, to the single fixed-override
  authoring this ADR's decision describes. GH118 later removed that local-IDE
  implementation outright: the resolver and the HMR plugin are gone with the rest
  of the local-IDE path.
- A drift guard test binds `docs/world/scenarios.json`, the registered scenarios,
  and the engine rules together, so the names cannot drift again.

## Scope of the first ticket (GH42)

GH42 sets this model and builds one scenario against it: `pin-brute-force`, renamed
from `kiosk-pin-attack`. It builds the engine seam, the registry, the assembler, the
merge seam, and the scaffold, wired for one scenario. The other 29 hunts and the
interactive picker UI are follow-ups.
