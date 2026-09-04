/**
 * GH137-PLAN.md: the decorative shortcut badge. Purely presentational — it is
 * `aria-hidden`, so it never enters any control's accessible name or description. The
 * binding itself is exposed to assistive tech on the OWNING control's own
 * `aria-keyshortcuts` attribute (the consuming component sets that, using
 * `kbdGlyph(key)` for the same text this badge shows), not by this badge's text. So a
 * button reading "Freeze" stays named "Freeze" even once this badge sits inside it.
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
