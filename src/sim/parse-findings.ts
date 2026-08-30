/**
 * The boundary parser for the player's `detect()` return. It replaces the old
 * `matchResult`: where that accepted an Alert, an array, null, or undefined, this
 * enforces ADR 0006's richer `Finding[]` contract before the scorer folds it.
 *
 * The rules are normative (ADR 0006, "Normative parser rules for T1"). Every
 * violation throws `RuleError("detect", ...)`, so the supervisor reports it
 * cleanly. "No finding" is the empty array `[]`; null, undefined, and a bare Alert
 * are all rejected. The scorer never sees a shape it cannot fold.
 */
import type { Finding } from "./finding";
import { RuleError } from "./rule-error";

/** Reject with a detect-phase RuleError. */
function reject(message: string): never {
  throw new RuleError("detect", message);
}

/**
 * A primitive string, by its tag (mirrors `tasks.ts`). The `instanceof Object`
 * guard rejects a boxed `new String(...)` and a `Symbol.toStringTag`-spoofed
 * object, both of which share the tag but are not the primitive the contract
 * promises. A boxed value would pass the parser and then fail the scorer's
 * strict-equality reason match, silently mis-scoring.
 */
function isString(value: unknown): value is string {
  return !(value instanceof Object) && Object.prototype.toString.call(value) === "[object String]";
}

function isNumber(value: unknown): value is number {
  return !(value instanceof Object) && Object.prototype.toString.call(value) === "[object Number]";
}

function isBoolean(value: unknown): value is boolean {
  return value === true || value === false;
}

/**
 * A plain object: `{}` or `Object.create(null)`, not an array, Date, Map, or
 * class instance. Mirrors `isPlainObject` in `tasks.ts`: a boxed primitive lands
 * on its own wrapper prototype and is rejected the same way as a class instance.
 */
function isPlainObject(value: unknown): value is object {
  if (value === null || value === undefined) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** A non-negative finite integer: a valid Event id or anchor. */
function isEventId(value: unknown): value is number {
  return isNumber(value) && Number.isInteger(value) && value >= 0;
}

/** A non-empty string: a reason or a subject key. */
function isNonEmptyString(value: unknown): value is string {
  return isString(value) && value.length > 0;
}

/**
 * A string or a finite number: the primitive a kv value or a table cell may hold.
 * Non-finite numbers are rejected here too, matching the json rule, so a shared
 * scenario file stays serialization-safe (`JSON.stringify` coerces NaN to null).
 */
function isStringOrNumber(value: unknown): value is string | number {
  return isString(value) || (isNumber(value) && Number.isFinite(value));
}

/**
 * True when `values` has no holes and every element passes `predicate`. Plain
 * `Array.prototype.every` skips a sparse hole and reports it as passing, so a
 * sparse `eventIds` or `columns` array would validate as dense. This walks every
 * index instead.
 */
function isDenseArrayOf(values: unknown[], predicate: (value: unknown) => boolean): boolean {
  for (let index = 0; index < values.length; index += 1) {
    if (!(index in values) || !predicate(values[index])) {
      return false;
    }
  }
  return true;
}

/**
 * Reject any own key of `value` not named in `allowed`, so unknown fields fail.
 * The value is always a plain object the caller has just narrowed; the guard keeps
 * this a boundary helper without a broad `object` parameter.
 */
function rejectUnknownKeys(value: unknown, allowed: string[], where: string): void {
  if (!isPlainObject(value)) {
    return;
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      reject(`Unknown field "${key}" on ${where}.`);
    }
  }
}

/**
 * The deepest a json widget value may nest. A `context` rides on a shared, and so
 * untrusted, scenario file, so a hand-crafted deep chain must reject cleanly rather
 * than overflow the call stack with a raw `RangeError`.
 */
const MAX_JSON_DEPTH = 100;

/**
 * Assert a value is JSON-serializable. Walks by hand rather than trusting
 * `JSON.stringify`, which silently coerces `NaN` to null and drops `undefined`
 * and functions inside arrays. The cycle guard is a recursion STACK, held in a
 * WeakSet: an object is added before its children are walked and removed after,
 * so a shared but non-cyclic reference like `{ a: x, b: x }` is accepted while a
 * true cycle is rejected. `depth` caps the nesting at `MAX_JSON_DEPTH`, so a deep
 * non-cyclic chain rejects with a RuleError instead of overflowing the stack. Only
 * arrays and plain objects descend; a Date, Map, or class instance is rejected
 * rather than passing as an empty object.
 */
function assertJsonValue(value: unknown, stack: WeakSet<object>, depth: number): void {
  if (depth > MAX_JSON_DEPTH) {
    reject(`A json widget value nests deeper than ${MAX_JSON_DEPTH} levels.`);
  }
  if (value === null || isBoolean(value) || isString(value)) {
    return;
  }
  if (isNumber(value)) {
    if (!Number.isFinite(value)) {
      reject("A json widget value holds a non-finite number.");
    }
    return;
  }
  if (Array.isArray(value)) {
    if (stack.has(value)) {
      reject("A json widget value holds a cycle.");
    }
    stack.add(value);
    for (const element of value) {
      assertJsonValue(element, stack, depth + 1);
    }
    stack.delete(value);
    return;
  }
  if (isPlainObject(value)) {
    if (stack.has(value)) {
      reject("A json widget value holds a cycle.");
    }
    stack.add(value);
    for (const child of Object.values(value)) {
      assertJsonValue(child, stack, depth + 1);
    }
    stack.delete(value);
    return;
  }
  reject(
    "A json widget value holds an unsupported type (a function, undefined, BigInt, Symbol, Date, Map, or class instance).",
  );
}

/** Validate one Widget of a known type, every field exactly, and reject extras. */
function parseWidget(widget: unknown): void {
  if (!isPlainObject(widget)) {
    reject("A context widget must be an object.");
  }
  if (!("type" in widget)) {
    reject("A context widget needs a type.");
  }
  if ("title" in widget && !isString(widget.title)) {
    reject("A widget title must be a string.");
  }
  switch (widget.type) {
    case "text": {
      rejectUnknownKeys(widget, ["type", "title", "text"], "a text widget");
      if (!("text" in widget) || !isString(widget.text)) {
        reject("A text widget needs a string text.");
      }
      return;
    }
    case "kv": {
      rejectUnknownKeys(widget, ["type", "title", "entries"], "a kv widget");
      if (!("entries" in widget) || !Array.isArray(widget.entries)) {
        reject("A kv widget needs an entries array.");
      }
      for (const entry of widget.entries) {
        if (!isPlainObject(entry)) {
          reject("A kv entry must be an object.");
        }
        rejectUnknownKeys(entry, ["label", "value"], "a kv entry");
        if (!("label" in entry) || !isString(entry.label)) {
          reject("A kv entry needs a string label.");
        }
        if (!("value" in entry) || !isStringOrNumber(entry.value)) {
          reject("A kv entry value must be a string or a number.");
        }
      }
      return;
    }
    case "table": {
      rejectUnknownKeys(widget, ["type", "title", "columns", "rows"], "a table widget");
      if (
        !("columns" in widget) ||
        !Array.isArray(widget.columns) ||
        !isDenseArrayOf(widget.columns, isString)
      ) {
        reject("A table widget needs a dense columns array of strings.");
      }
      if (!("rows" in widget) || !Array.isArray(widget.rows)) {
        reject("A table widget needs a rows array.");
      }
      const width = widget.columns.length;
      for (const row of widget.rows) {
        if (!Array.isArray(row)) {
          reject("A table row must be an array.");
        }
        if (row.length !== width) {
          reject("A table row length must equal the columns length.");
        }
        for (const cell of row) {
          if (!isStringOrNumber(cell)) {
            reject("A table cell must be a string or a number.");
          }
        }
      }
      return;
    }
    case "json": {
      rejectUnknownKeys(widget, ["type", "title", "value"], "a json widget");
      if (!("value" in widget)) {
        reject("A json widget needs a value.");
      }
      assertJsonValue(widget.value, new WeakSet(), 0);
      return;
    }
    default:
      reject("A context widget has an unknown type.");
  }
}

/** Validate the scored Alert core; reject any extra field. Returns the cited ids. */
function parseAlert(alert: unknown): number[] {
  if (!isPlainObject(alert)) {
    reject("Each finding needs an alert object.");
  }
  rejectUnknownKeys(alert, ["eventIds", "reason", "at"], "an alert");
  if (!("eventIds" in alert) || !Array.isArray(alert.eventIds) || alert.eventIds.length === 0) {
    reject("alert.eventIds must be a non-empty array.");
  }
  if (!isDenseArrayOf(alert.eventIds, isEventId)) {
    reject("alert.eventIds must hold non-negative finite integers with no gaps.");
  }
  if (!("reason" in alert) || !isNonEmptyString(alert.reason)) {
    reject("alert.reason must be a non-empty string.");
  }
  if (!("at" in alert) || !isNumber(alert.at) || !Number.isFinite(alert.at)) {
    reject("alert.at must be a finite number.");
  }
  return alert.eventIds;
}

/** Validate one Finding: its alert, then the optional anchor, grouping, and display. */
function parseFinding(finding: unknown): void {
  if (!isPlainObject(finding)) {
    reject("Each finding must be an object.");
  }
  rejectUnknownKeys(
    finding,
    ["alert", "context", "eventId", "subjectType", "isPartial"],
    "a finding",
  );
  const eventIds = parseAlert("alert" in finding ? finding.alert : undefined);

  // The anchor is now required. Checked right after `parseAlert`, so its cited ids
  // exist for the membership test, and before the subject, partial, and context
  // checks, all of which read a resolved anchor.
  if (!("eventId" in finding) || finding.eventId === undefined) {
    reject("Each finding needs an eventId.");
  }
  if (!isEventId(finding.eventId)) {
    reject("eventId must be a non-negative finite integer.");
  }
  if (!eventIds.includes(finding.eventId)) {
    reject("eventId must be a member of alert.eventIds.");
  }

  if ("subjectType" in finding && finding.subjectType !== undefined) {
    if (!isNonEmptyString(finding.subjectType)) {
      reject("subjectType must be a non-empty string.");
    }
  }

  if ("isPartial" in finding && finding.isPartial !== undefined) {
    if (!isBoolean(finding.isPartial)) {
      reject("isPartial must be a boolean.");
    }
  }

  if ("context" in finding && finding.context !== undefined) {
    if (!Array.isArray(finding.context)) {
      reject("context must be an array of widgets.");
    }
    for (const widget of finding.context) {
      parseWidget(widget);
    }
  }
}

/** Validate one finding, then report it as a Finding so the array narrows cleanly. */
function isFinding(value: unknown): value is Finding {
  parseFinding(value);
  return true;
}

/**
 * Parse the Rule's `detect()` return into `Finding[]`, or throw. The return must
 * be an array; each element is validated exactly. On success the same array is
 * returned, now guaranteed to satisfy the `Finding` contract.
 *
 * A sparse array (a hole from `new Array(1)` or an elision like `[, x]`) is
 * malformed, not "no finding". `filter` would silently skip a hole, so reject any
 * gap first, then let `isFinding` narrow the dense array.
 */
export function parseFindings(value: unknown): Finding[] {
  if (!Array.isArray(value)) {
    reject("detect must return an array of findings (use [] for no finding).");
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value)) {
      reject("detect returned a sparse array; every finding index must be present.");
    }
  }
  return value.filter(isFinding);
}
