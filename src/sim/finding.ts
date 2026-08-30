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

/**
 * One detection the Algorithm emits from detect(). Every Finding carries an anchor,
 * so it is promotable, and groupable when `subjectType` is set.
 *
 * `eventId` is an anchor: one representative cited event, normally the first, and a
 * member of `alert.eventIds`. To promote a watch, re-emit a Finding with the same
 * `reason` for the same subject, without `isPartial`; the old one is replaced, not
 * mutated. A partial "watch", like "3 wrong PINs, needs 5", lives here. The scorer
 * skips a partial. The UI shows it and ages it out. The scorer keys a grouped finding's
 * live row on its resolved entity and `reason`, not the anchor, so a hunt whose anchor
 * shifts mid-attack still lands on one row per subject; see `correctness.ts`.
 */
export interface Finding extends FindingBase {
  /** The anchor: one representative cited event, normally the first, a member of
   *  `alert.eventIds`. The scorer keys the live row on resolved entity + `reason` when
   *  `subjectType` resolves, else on `eventId` + `reason`. */
  eventId: number;
  /**
   * Names the field on the anchor event that holds the entity value.
   * It MUST name a field on the normalized record. A `subjectType` that names no
   * field on the record is an error. The UI reads `event[subjectType]` to group
   * findings, and the resolved value must be a primitive, a string or a number.
   * Example: `subjectType: "acct"` resolves to the account value. Optional. Omit it
   * and the finding is not grouped.
   */
  subjectType?: string;
  /** A partial "watch", promoted later to a final for the same subject and `reason`. Each
   *  emission carries a valid `eventId`; the anchor may differ across emissions. */
  isPartial?: boolean;
}

/**
 * The flat, per-Event view detect() receives: the normalized payload spread first,
 * then the engine fields. Engine fields win, so a payload field named `id` cannot
 * shadow the real id. This mirrors `withEngineFields` in `tasks.ts`.
 */
export interface DetectView {
  id: number;
  ts: number;
  endpoint: string;
  [key: string]: unknown;
}

/** The player's detect callable. One Event view in, Findings out. Synchronous. */
export type Detect = (event: DetectView) => Finding[];

/**
 * The player's Algorithm module, as authored. `normalize` is optional: the loader
 * defaults an omitted `normalize` to identity, so a detect-only module is valid.
 */
export interface Algorithm {
  normalize?: (raw: unknown) => unknown;
  detect: Detect;
}
