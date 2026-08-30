# ADR 0006 — The engine authoring contract: detect() returns Finding[]

- Status: Accepted
- Date: 2026-08-29

## Context

The player writes an Engine. The Engine reports what it detects. Today it reports an `Alert`:
a reason, a time, and the Event ids it cites. That was enough for the first slice, where a
detection is one flat verdict and the scorer is the only reader.

The epic needs more. The UI wants to show a partial "watch" that has not fired yet, like "3
wrong PINs, needs 5", and age it out. It wants to group findings by subject so an operator
sees one row per account, not one per Event. It wants a debugging payload the author controls,
richer than a reason string. None of that fits an `Alert`, and every downstream ticket in the
epic depends on the answer. T1 builds the boundary parser against it. T4, T5, and T11 import
the types. If the shape is wrong, that mistake forks across four parallel work streams before
anyone notices. So the shape gets decided here, first, on its own, with a type-level test that
proves it before the parallel work starts. That is the whole reason T0 exists as its own ticket
and is not folded into T1.

The question this ADR settles: what does the player's detection code return, and how is it
called?

## Decision

Keep the per-Event pipeline. Evolve the call.

- Rename `match()` to `detect()`. Keep `normalize()` as it is.
- `detect()` returns `Finding[]`, never an `Alert`. It is synchronous. It returns an array,
  never a `Promise`.
- The Engine calls `detect(view)` once per Event, with one flat view and nothing else. No
  `api`, no history window, no store handle. The player holds all detection state in their own
  module, in a closure they own.
- The scorer stays a mechanism. It reads `finding.alert`. It skips any `isPartial` finding. It
  credits the real ones by `reason` and cited `eventIds`, exactly as it does today.

A `Finding` is the richer shape. Its scored core is an `Alert`, unchanged in spirit but renamed
in one field. Around that core it adds an optional anchor (`eventId`), an optional grouping key
(`subjectType`), a partial flag (`isPartial`), and an optional display payload (`context`) built
from a typed widget vocabulary. The type splits into two arms, `Anchored` and `OneShot`, so two
rules hold at compile time: `subjectType` needs an `eventId`, and a partial needs an `eventId`.
You cannot ask to group without an anchor to group on, and you cannot promote a watch that has
no key.

Why the player owns state. `CONTEXT.md` is explicit that the player improves the Engine by
rewriting the Algorithm, and that ground truth lives in the scorer, apart from the Events the
Algorithm sees. Hand the player a window, or let the scorer do the grouping, and the player is
no longer authoring detection. That guts the game. So `detect()` takes one flat Event view and
the player keeps their own ring in a closure. This is also what feeds the Cost and Optimization
pressure later: the player's own retained state is the thing that gets expensive.

Why `detect()` is synchronous. The Match task calls player code once per Event with no `await`
(`runMatch` in `tasks.ts`). It folds the return, charges the governor once, then forwards the
Event. An `async detect()` would hand back a `Promise`, which the boundary parser has to reject,
so allowing it would only create a failure mode. The contract is synchronous by design, and the
`Detect` type encodes it: it returns `Finding[]`, not `Promise<Finding[]>`.

## The types

These land in `src/sim/finding.ts`, with doc comments the block below omits for brevity. Types
only, no runtime. The parser that enforces them at the boundary is T1's job, and the rules below
are its spec.

```typescript
/** Each Scenario names its own reasons. The scorer matches them by value. */
export type AlertReason = string;

/**
 * The scored core of a Finding. The scorer reads only this.
 * It credits by `reason` and `eventIds`. It never reads `at`.
 */
export interface Alert {
  /** Ids of the Events this Alert cites as evidence. */
  eventIds: number[];
  /** The reason value, matched against ground-truth Attacks. */
  reason: AlertReason;
  /** Game seconds the pattern crossed. Display metadata. The scorer ignores it. */
  at: number;
}

/** A JSON-serializable value. The `json` widget carries one, so a shared file stays safe. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/** A typed display widget. The host renders each type with a trusted component. */
export type Widget =
  | { type: "text"; title?: string; text: string }
  | { type: "kv"; title?: string; entries: { label: string; value: string | number }[] }
  | { type: "table"; title?: string; columns: string[]; rows: (string | number)[][] }
  | { type: "json"; title?: string; value: JsonValue };

/** Optional, display-only. An ordered list of widgets. The scorer ignores it. */
export type Context = Widget[];

/** Fields shared by every Finding, partial or final. */
interface FindingBase {
  /** The scored core. Always present. */
  alert: Alert;
  /** Optional free-form display payload. */
  context?: Context;
}

type Anchored = FindingBase & {
  eventId: number;
  subjectType?: string;
  isPartial?: boolean;
};

type OneShot = FindingBase & {
  eventId?: undefined;
  subjectType?: undefined;
  isPartial?: false;
};

export type Finding = Anchored | OneShot;

export interface DetectView {
  id: number;
  ts: number;
  endpoint: string;
  [key: string]: unknown;
}

/** The player's detect callable. One Event view in, Findings out. Synchronous. */
export type Detect = (event: DetectView) => Finding[];

/** The player's Algorithm module. `normalize` is optional; the loader defaults it to identity. */
export interface Algorithm {
  normalize?: (raw: unknown) => unknown;
  detect: Detect;
}
```

The field decisions, in short. `events` becomes `eventIds`, because the name should say the
array holds ids, and camelCase is house style. Entity leaves the scored core, because the scorer
never used it. The UI groups by subject instead, and it does that with `subjectType` plus
`eventId` rather than a full `Subject` object: the producer names the field on the anchor event,
the UI reads `event[subjectType]` and derives the value. That drops a field and reuses knowledge
the producer already has. `at` stays on the `Alert` as display metadata for the timeline, and
the scorer keeps ignoring it.

`Context` is a typed widget vocabulary, not a free-form HTML blob. The reason is concrete, not
stylistic. A scenario file is shareable, so a `context` authored on one machine is untrusted
input on another. Author HTML plus a sanitizer is a real XSS surface and easy to misconfigure. A
sandboxed iframe is overkill for a debug panel. A typed vocabulary renders only data through the
host's own trusted components, so a shared file can never inject script. The `json` widget is the
escape hatch, a collapsed tree over any value, and it carries a recursive `JsonValue` rather than
`unknown` so the payload is guaranteed serializable. The vocabulary is open: a later ticket adds a
widget by adding one union member and one renderer.

## Normative parser rules for T1

The boundary parser replaces `matchResult`. It validates the player's `detect()` return before
the scorer folds it. These rules are the spec, and they are normative. T1 implements them with
tests.

- The return must be an array. A non-array is a `detect` RuleError.
- Each element needs an `alert` object. Its `eventIds` must be a non-empty array of non-negative
  finite integers. Its `reason` must be a non-empty string. Its `at` must be a finite number.
- If `eventId` is present, it must be a non-negative finite integer and a member of
  `alert.eventIds`.
- If `subjectType` is present, it must be a non-empty string, and `eventId` must be present too.
  The parser checks the string only. That it names a real field on the anchor record, and that
  the resolved value is a primitive, is a runtime and UI concern, not a shape check here.
- If `context` is present, it must be an array of valid Widgets.
- If `isPartial` is present, it must be a boolean.
- A partial (`isPartial: true`) requires `eventId`.
- Each `Widget` must have a known `type`, and every field of that widget is validated exactly.
  A `text` widget needs a string `text`. A `kv` widget needs an `entries` array of
  `{ label: string, value: string | number }`. A `table` widget needs string `columns` and
  `rows` of string-or-number cells, and every row length must equal the `columns` length, so the
  table is rectangular. A `json` widget needs a `value` that is JSON-serializable.
- A `json` value is rejected if it holds a non-finite number, a cycle, or an unsupported type
  such as a function, `undefined`, or a `BigInt`.
- Unknown top-level fields on a Finding, an Alert, or a Widget are rejected.

## Consequences

The types land now and change nothing at runtime. T0 is additive. The consequences below are
what T1 and T2 carry out once the parser and the scorer move onto `finding.ts`.

`tasks.ts`. Today `matchResult(value)` parses the return into `Alert | Alert[] | null`, `isAlert`
checks a single `Alert` by shape, and `runMatch` folds that into the scorer. After T1, a
`parseFindings(value)` returns `Finding[]` under the rules above, the `RuleError` phase union
changes from `"normalize" | "match"` to `"normalize" | "detect"`, `runMatch` becomes `runDetect`,
and the `NODE_TASKS` registry key `"match"` becomes `"detect"`. `withEngineFields` already builds
the flat view the `DetectView` type describes, engine fields last so a payload field named `id`
cannot shadow the real id, so it stays as it is.

`correctness.ts`. Today `record(alerts, env)` takes `Alert | Alert[] | null | undefined` and
`scoreAlert` reads `alert.events`. After T2, the scorer folds `Finding[]`, reads `finding.alert`,
skips any `isPartial` finding, and credits by `alert.eventIds` instead of `alert.events`. The
scoring math and the attack-keyed matching do not change. Only the field name and the partial
skip are new.

`AlgorithmEditor.tsx`. The seeded source template exports `match`, and the error phase renders
`{error.phase}` straight from the `RuleError`. After T11, the template seeds `detect` and returns
`Finding[]`, and the phase label reads `detect`. The download filename and the run wiring do not
change.

## The rename surface and the alert.ts transition

The rename from `match` to `detect` is repo-wide, not three files. T1 starts with one sweep:

```text
grep -rniE '\bmatch\b|matchResult|MatchNode|RuleError' src/ tools/ docs/ ARCHITECTURE.md CONTEXT.md
```

Known sites, so T1 confirms the grep found no others:

- `src/sim/tasks.ts`: `TaskAlgorithm.match`, `runMatch`, `matchResult`, the `TaskScorer` alert
  wording, and the `RuleError` phase union `"normalize" | "match"` with its message strings.
- `src/sim/tasks.ts`: the Node-kind registry key `"match"` in `NODE_TASKS`.
- Graph and topology: any graph validation, the store topology, and the Pipeline node
  registration that name the `"match"` kind.
- UI: the `MatchNode` component and its CSS class names.
- `src/game/algorithm.ts`: `LoadedAlgorithm.match`, `AlgorithmModule.match`, and the loader
  error string "The Algorithm must export a `match` function."
- `src/game/profiler/worker-support.ts`: the profiler validates and invokes `match` through the
  same parse path.
- `src/ui/AlgorithmEditor.tsx`: the seeded source template and the error phase label.
- The seeded Scenario sources the editor downloads.
- Every test that names `match`, `matchResult`, the `"match"` kind, or the `"match"` phase.
- Docs: `ARCHITECTURE.md`, whose measured-cost note names the synchronous `match()`, and any
  other doc the grep flags. The sweep covers prose, not just code, because the docs name
  `match()` too.

The `alert.ts` transition. T0 is non-breaking, so the legacy `src/sim/alert.ts` stays in place.
It still wires the running pipeline through `tasks.ts` and `correctness.ts`, and its `Alert` type
keeps its old `events` field. The new `Alert` lives in `finding.ts` with `eventIds`. So two types
named `Alert` overlap for exactly one ticket. Both are module-scoped and imported by explicit
path, so there is no name or resolution collision. This is intended and temporary. New code
imports from `src/sim/finding.ts`. T1 does the migration: it moves the pipeline onto `finding.ts`,
renames `events` to `eventIds` at every call site, and deletes `src/sim/alert.ts`.

## The Node-kind rename and back-compat

The graph kind `"match"` becomes `"detect"`, for consistency with the callable. T1 does it.

Clean rename, no compatibility alias. Nothing has shipped, so no saved player Algorithm depends
on `match`. Keeping an alias would only carry a dead name forward. T1 renames every site at once.

## Known limit: anchor retention

Resolving a `subjectType` reads `event[subjectType]` on the anchor event, which means the anchor
event has to still be findable when the UI groups. This contract does not retain events. That
retention is a UI concern, owned by T3's recent-event ring and T10's decision snapshot, not by
`finding.ts`. The type states the requirement, that the resolved value be a primitive string or
number, and leaves the retention window to the tickets that own it. I am flagging it here so it
does not get discovered late.

## Alternatives weighed

The push API (Option B). The prototype used `registerHunt` / `watch` / `hit`, a per-tick push
where the Engine calls into player callbacks. It reads well for streaming detectors, but it
inverts control and makes the Engine own a retained log ring, which is exactly the state we
decided the player should own. It also breaks the ADR 0004 cost model, which measures the work
`detect()` does per one Event. A per-tick sweep has no per-Event anchor to charge against.
Reopening a settled cost ADR is out of scope for this epic. So we keep the per-Event pull and put
the richness in the return shape instead.

## Housekeeping note

Resolved. Two ADR files once shared the number 0004. `0004-local-dev-kit.md` was renumbered
(and its decision revised) to `0008-native-algorithm-hot-reload.md`, leaving
`0004-measured-cost-model.md` as the only 0004. This closed issue #85. The renumber target
was 0007, but `0007-actor-based-world-simulation.md` (#88) took that number first, so it
landed at 0008.
