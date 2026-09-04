/**
 * GH137-PLAN.md: the decorative shortcut badge (`Kbd`) and the static shortcut-hint
 * row it composes into (`ShortcutHint`). Both are purely presentational — every key
 * renders `aria-hidden`, so it never enters any control's accessible name or
 * description. A control's own binding is exposed to assistive tech on the OWNING
 * control's own `aria-keyshortcuts` attribute (the consuming component sets that,
 * using `ariaKeyshortcut(key)` — the canonical WAI-ARIA token, distinct from this
 * badge's own `kbdGlyph(key)` display text, since a short glyph like `Esc` is not a
 * valid `aria-keyshortcuts` token), not by this badge's text. So a button reading
 * "Freeze" stays named "Freeze" even once this badge sits inside it.
 */
import { kbdGlyph } from "./shortcuts.data";

interface KbdProps {
  /** The raw `ShortcutDef.key`, e.g. `"M"`, `" "`, `"Escape"`. Rendered through
   *  `kbdGlyph` for display. */
  shortcutKey: string;
}

export function Kbd({ shortcutKey }: KbdProps) {
  return (
    // biome-ignore lint/a11y/noAriaHiddenOnFocusable: a bare <kbd> has no native tabindex or interactive role, so it is not focusable; the binding reaches assistive tech via the owning control's own aria-keyshortcuts instead (GH137-PLAN.md).
    <kbd className="kbd" aria-hidden="true">
      {kbdGlyph(shortcutKey)}
    </kbd>
  );
}

/** One `<ShortcutHint>` row: one or more keys shown together (e.g. both arrows for a
 *  single "move" label), plus the label they explain. Not exported: no caller outside
 *  this file builds one yet — `use-tour.ts` needs the same shape but builds plain DOM
 *  instead (driver.js's popover lives outside React), so it does not import this type
 *  either. */
interface ShortcutHintEntry {
  /** Raw keys, in the same `KeyboardEvent.key` spelling `Kbd`/`kbdGlyph` read. */
  readonly keys: readonly string[];
  readonly label: string;
}

interface ShortcutHintProps {
  entries: readonly ShortcutHintEntry[];
}

/** A static row of key+label pairs (GH137-PLAN.md M3): the tour footer's own
 *  `← → move · Esc exit` line, built from this same shape by `use-tour.ts` as plain
 *  DOM (driver.js's popover lives outside React), and available here for any other
 *  in-React caller. Each key renders through `Kbd`, so it stays `aria-hidden` and
 *  never enters an ancestor's accessible name. */
export function ShortcutHint({ entries }: ShortcutHintProps) {
  return (
    <p className="shortcut-hint">
      {entries.map((entry, index) => (
        <span className="shortcut-hint-entry" key={entry.label}>
          {index > 0 ? (
            <span className="shortcut-hint-sep" aria-hidden="true">
              {" · "}
            </span>
          ) : null}
          {entry.keys.map((key, keyIndex) => (
            <span key={key}>
              {keyIndex > 0 ? " " : ""}
              <Kbd shortcutKey={key} />
            </span>
          ))}
          {` ${entry.label}`}
        </span>
      ))}
    </p>
  );
}
