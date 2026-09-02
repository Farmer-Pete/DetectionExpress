# ADR 0011 - World data moves from JSON to typed TS modules

- Status: Accepted
- Date: 2026-09-02
- Supersedes parts of ADR 0007 (actor-based world simulation): the claim that
  `world.json` stays JSON, and the claim that `parseWorld` is the runtime authority
  on the world's shape.

## Context

The world data crossed an untyped JSON boundary in four files: `docs/world/world.json`,
`docs/world/scenarios.json`, `docs/world/sensors.json`, and `docs/world/manufacturers.json`. Each
had a JSON Schema alongside it (`*.schema.json`), but nothing in the project enforced those
schemas — there is no ajv or zod dependency, and the `$schema` key only fed editor hints. The
actual shape lived a second time in the `World` interface and a 658-line `parseWorld` in
`src/sim/world/world.ts`, which took `unknown` and re-derived the same structure with 52 throws.

That split meant `tsc` never checked `world.json`. A bad edit to the data — a missing field, a
typo'd enum value, a boxed `Boolean` — failed only when a test happened to run the parser, not at
compile time. This is the "two truths drift apart" risk ARCHITECTURE rule 6 warns against: the
type and the runtime validator were two hand-written descriptions of the same shape, free to go
out of sync.

`sensors.json` and `manufacturers.json` were worse off: nothing imported them. They were dead
reference data, while two UI tables hardcoded sensor names that duplicated `sensors.json`'s
content by hand.

## Decision

Convert all four world data files to typed TS modules, each `as const satisfies <Type>`, and
delete the JSON Schemas.

- `docs/world/world.json` -> `src/sim/world/world.data.ts`, satisfying `World`.
- `docs/world/scenarios.json` -> `src/game/scenarios.data.ts`, satisfying `CatalogueData`.
- `docs/world/sensors.json` -> `src/game/sensors.data.ts`, satisfying a new `SensorData`.
- `docs/world/manufacturers.json` -> `src/game/manufacturers.data.ts`, satisfying a new
  `ManufacturerData`.

The compiler now owns every structural constraint a type can express: field presence, primitive
type, and literal unions such as `Zone.trustLevel` (`0 | 1 | 2 | 3 | 4`) and `Site.type`. A
shape-breaking edit fails `tsc --noEmit` immediately, at the same place any other type error would
surface, rather than waiting on a test run.

`parseWorld(unknown): World` is deleted along with its structural guards (`isString`,
`isFiniteNumber`, `parseZone`, `parseDoor`, and so on). In its place, `assertWorldConsistent(world:
World): void` in `src/sim/world/world.ts` keeps only the checks a type cannot express:
referential integrity (ids resolve, edges reciprocate, membership agrees both ways), graph
connectivity, uniqueness, and finite/range checks (`Number.isFinite(minutes)`, a non-positive
travel time, the `^z[0-4]$` zone id shape). It runs once at module load, the way `parseWorld` did,
against the now-typed `worldData` singleton.

The two previously dead files gain real consumers: a `sensor-catalogue` lookup indexes
`sensors.data` by id and resolves each vendor through `manufacturers.data`, and a new
`src/game/world-data-integrity.test.ts` imports all four data modules and asserts the
cross-reference invariants nothing checked before — every sensor names at least one real
manufacturer, every manufacturer's `makes` list resolves back to a real sensor and the two
directions agree, every scenario's `sensors` list resolves, every `foundAt` token resolves against
`world.json`'s zones/stations/sites, and every line's `trainName` is non-empty and agrees with
`trainName(trainIdForLine(line))`. Each invariant is proven both on the real data and on a seeded
broken clone, so a missing check cannot pass silently.

## The trade

We give up editor-time JSON-Schema validation: hex-color and URL-format hints, and autocomplete
while hand-editing a `.json` file. A `.ts` file cannot carry a `$schema` pointer, so that class of
nagging is gone.

In exchange we gain compile-time structural checking that a JSON Schema never gave us — `tsc`
already runs on every build and every save, where the schema only ran when an editor's JSON
language server happened to be active — plus the enforced runtime cross-reference invariants in
`assertWorldConsistent` and the new integrity test, which the schemas never expressed at all (a
JSON Schema cannot state "this id must resolve in that other file").

## Alternatives weighed

- Keep the JSON files and add a runtime validator library (ajv or zod). Rejected: it is a new
  dependency for a check `tsc` already gives for free once the data is TS, and it still validates
  at runtime rather than at compile time.
- Keep the JSON files and the schemas, and accept the drift risk. Rejected: this is the status quo
  ADR 0007 recorded and the risk ARCHITECTURE rule 6 names directly.
- Convert only `world.json`, leaving `sensors.json` and `manufacturers.json` as dead JSON. Rejected:
  those two files had no importer and no enforcement either way; converting only one file leaves
  the other two exactly as dead and untyped as before.

## Consequences

- `docs/world/*.schema.json` (all four) are deleted. A schema cannot attach to a `.ts` file, so an
  orphaned schema helps nothing.
- `Site.type`, `ControlCenter.type`, and `Zone.trustLevel` tighten to literal unions on the `World`
  interface in `src/sim/world/world.ts`.
- `world.test.ts` drops the four cases the compiler now owns (missing field, unknown site type,
  invalid control-center type, boxed `Boolean`) and keeps every referential case, now exercised
  against `assertWorldConsistent`.
- `docs/world/README.md` is updated: the file table, the connection diagram, and the intro line
  now point at the four `src/...data.ts` locations and name `assertWorldConsistent` rather than
  `parseWorld`.
- This ADR supersedes the ADR 0007 lines that state `world.json` stays JSON and that `parseWorld`
  is the runtime authority on it. Those lines are annotated in place, pointing here, rather than
  rewritten, so the history stays legible.
