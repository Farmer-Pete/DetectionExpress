/**
 * GH137-PLAN.md: two DOM-only predicates for "is the player typing right now", pure and
 * React-free.
 *
 * `isEditableTarget` is extracted UNCHANGED from `LogPanel.tsx`'s own Space-to-freeze
 * guard (it treats every `<input>` as editable, radio included) — `LogPanel` now imports
 * it from here instead of defining it locally, so its Space behavior is identical to
 * before this extraction.
 *
 * `isTextEntry` is a separate, narrower predicate for the mnemonic dispatcher
 * (`use-shortcuts.tsx`): textarea, `contenteditable`, and text-like `<input>` types only.
 * A focused `ChaosLadder` radio must NOT suppress every letter mnemonic the way it
 * suppresses Space, so the dispatcher reads this predicate, never `isEditableTarget`.
 */

/** True when a key event targets an editable element (LogPanel's original rule: every
 *  `<input>` counts, a radio included). Space-to-freeze reads this. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable;
}

/** `<input type="...">` values a player actually types free text into. A radio,
 *  checkbox, range, color, button/submit/reset, and file input are excluded — those are
 *  discrete controls, not text entry, and must not suppress a letter mnemonic. An input
 *  with no explicit `type` attribute defaults to `"text"` per the HTML spec, so it is
 *  covered here too. */
const TEXT_INPUT_TYPES: ReadonlySet<string> = new Set([
  "text",
  "search",
  "url",
  "tel",
  "email",
  "password",
  "number",
  "date",
  "datetime-local",
  "month",
  "week",
  "time",
]);

/** True only for a genuine text-entry surface: a textarea, a `contenteditable` element,
 *  or a text-like `<input>`. A radio (or any other discrete input) reads false, so it
 *  never suppresses the mnemonic dispatcher — unlike `isEditableTarget` above, which the
 *  Space-to-freeze guard still uses. */
export function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target.tagName === "TEXTAREA" || target.isContentEditable) {
    return true;
  }
  return target instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(target.type);
}
