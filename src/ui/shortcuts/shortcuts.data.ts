/**
 * GH137-PLAN.md: single-character keyboard shortcuts, pure data. No React, no DOM —
 * `use-shortcuts.tsx` and `use-shortcut.ts` are the only readers that touch the DOM or
 * React state.
 *
 * A `Scope` is one complete visible surface: the always-on `shell` (topbar + transport),
 * a composite side-panel tab (its shared chrome plus that tab's own body), a composite
 * map-dialog kind (`MapDialogShell` chrome plus the Event/Place body), the trace overlay,
 * or the Hire Me card. `SHORTCUTS` lists every command visible on that surface at once,
 * including "badge only" entries whose key already has an owner elsewhere (`Space` =
 * LogPanel's freeze toggle, `Escape` = `focus.ts`'s dialog dismissal, the arrow keys =
 * roving tabs / driver.js). The invariants below are unit-tested in
 * `shortcuts.data.test.ts`, iterated over every scope: within one scope no two keys
 * collide (case-insensitively, since `Shift+m` and `m` both dispatch the same entry),
 * and every entry whose `key` is a `RESERVED` key MUST carry `dispatch: false` — that
 * single field is what both the invariant test and `use-shortcuts.tsx`'s registration
 * path read to tell a badge-only entry from a live one.
 *
 * MILESTONE NOTE (GH137-PLAN.md M2): M1 wired only the `shell` scope (Topbar hamburger,
 * LogPanel Freeze/speeds, FindingsPanel "+N more"). M2 lifts Hire Me's `open` state into
 * `App` (so `shell`'s `H` opener and the `hireMe` scope's own `H`/Escape both resolve
 * correctly) and wires every composite dialog/panel scope: `sidepanel:*` (Close badge,
 * plus Options' Retake tour/Map toggle and Algorithm's Reset/Apply), `mapDialog:event` /
 * `mapDialog:place` (Back, Close badge, Event's own Open place), `trace` and `legend`
 * (Close badge each). M3 adds the tour popover hint (`tour/use-tour.ts`'s
 * `appendShortcutHint`) and the operability/focus-ring sweep (`src/index.css`); it
 * touches no `ShortcutDef` here.
 */

/** One complete visible surface. See the module doc for what "complete" means. */
export type Scope =
  | "shell"
  | "sidepanel:chaos"
  | "sidepanel:algorithm"
  | "sidepanel:options"
  | "mapDialog:event"
  | "mapDialog:place"
  | "trace"
  | "legend"
  | "hireMe";

export interface ShortcutDef {
  /** Stable within its scope; matches the `id` a control's `useShortcut` call passes. */
  readonly id: string;
  /** The literal `KeyboardEvent.key` this control answers to (case-insensitive; the
   *  exact-case form some special keys need to match `RESERVED`, e.g. `"Escape"`). */
  readonly key: string;
  /** A short human-readable name for the command, e.g. "Menu". Never injected into a
   *  control's accessible name — `Kbd.tsx`'s badge is `aria-hidden`; the binding is
   *  exposed via `aria-keyshortcuts` on the owning control instead. */
  readonly label: string;
  /** Default `true`. `false` = badge-only: `use-shortcuts.tsx` renders the `<Kbd>` badge
   *  data for this entry but never registers a dispatch handler for it — the key already
   *  has an owner (Space, Escape, or an arrow key). */
  readonly dispatch?: boolean;
}

/** Keys the dispatcher must never take over (`KeyboardEvent.key`'s own casing/spelling).
 *  `Space`/`Escape`/the arrows already have an owner elsewhere in the app; the invariant
 *  test enforces that every `SHORTCUTS` entry using one of these carries `dispatch:
 *  false`, and `use-shortcuts.tsx`'s registration path refuses to register a live
 *  handler for one even if a future entry forgets that flag. */
export const RESERVED: ReadonlySet<string> = new Set([" ", "Escape", "ArrowLeft", "ArrowRight"]);

export const SHORTCUTS: Readonly<Record<Scope, readonly ShortcutDef[]>> = {
  shell: [
    { id: "menu", key: "M", label: "Menu" },
    { id: "freeze", key: " ", label: "Freeze", dispatch: false },
    { id: "speed-0.5x", key: "1", label: "0.5x" },
    { id: "speed-1x", key: "2", label: "1x" },
    { id: "speed-2x", key: "3", label: "2x" },
    { id: "findings-more", key: "F", label: "Show more findings" },
    { id: "legend-open", key: "L", label: "Show legend" },
    // Opens the Hire Me card (it is closed while this scope is active — the card
    // owns its own "hireMe" scope once open, with its own "H" entry below that
    // closes it, GH137-PLAN.md M2).
    { id: "hire-me-open", key: "H", label: "Hire me" },
  ],
  "sidepanel:chaos": [{ id: "close", key: "Escape", label: "Close panel", dispatch: false }],
  "sidepanel:algorithm": [
    { id: "close", key: "Escape", label: "Close panel", dispatch: false },
    { id: "reset", key: "R", label: "Reset to default" },
    { id: "apply", key: "A", label: "Apply" },
  ],
  "sidepanel:options": [
    { id: "close", key: "Escape", label: "Close panel", dispatch: false },
    { id: "retake-tour", key: "T", label: "Retake tour" },
    { id: "map-toggle", key: "P", label: "Map toggle" },
  ],
  "mapDialog:event": [
    { id: "back", key: "B", label: "Back" },
    { id: "close", key: "Escape", label: "Close", dispatch: false },
    { id: "open-place", key: "O", label: "Open place" },
  ],
  "mapDialog:place": [
    { id: "back", key: "B", label: "Back" },
    { id: "close", key: "Escape", label: "Close", dispatch: false },
  ],
  trace: [{ id: "close", key: "Escape", label: "Close trace", dispatch: false }],
  legend: [{ id: "close", key: "Escape", label: "Close legend", dispatch: false }],
  hireMe: [
    { id: "hire-me-close", key: "H", label: "Hire me" },
    { id: "dismiss", key: "Escape", label: "Dismiss", dispatch: false },
  ],
};

/** The key a scope's control answers to, or `undefined` if `id` is not declared there. */
export function assignedKey(scope: Scope, id: string): string | undefined {
  return SHORTCUTS[scope].find((entry) => entry.id === id)?.key;
}

/** Display glyphs for keys whose `KeyboardEvent.key` spelling reads poorly as a badge.
 *  Anything else (a plain letter or digit) passes through unchanged. For the visible
 *  `<kbd>` badge ONLY (`Kbd.tsx`) — never for `aria-keyshortcuts`, see `ariaKeyshortcut`
 *  below (code review MAJOR fix: this table's short glyphs are not valid WAI-ARIA
 *  tokens, e.g. `"Esc"` is not `"Escape"`). */
const GLYPHS: Readonly<Record<string, string>> = {
  " ": "Space",
  Escape: "Esc",
  ArrowLeft: "←",
  ArrowRight: "→",
};

/** The `<kbd>` badge's display text for a key, e.g. `" "` -> `"Space"`, `"M"` -> `"M"`.
 *  Display only — do not use this for `aria-keyshortcuts`; use `ariaKeyshortcut`. */
export function kbdGlyph(key: string): string {
  return GLYPHS[key] ?? key;
}

/** Canonical WAI-ARIA `aria-keyshortcuts` tokens
 *  (https://www.w3.org/TR/wai-aria-1.1/#aria-keyshortcuts). Distinct from `kbdGlyph`'s
 *  short on-screen glyphs: `Escape`/`ArrowLeft`/`ArrowRight` are valid tokens spelled
 *  out in full, unlike `kbdGlyph`'s `Esc`/`←`/`→`, which read fine on a badge but are
 *  not valid ARIA key names. */
const ARIA_TOKENS: Readonly<Record<string, string>> = {
  " ": "Space",
  Escape: "Escape",
  ArrowLeft: "ArrowLeft",
  ArrowRight: "ArrowRight",
};

/** The `aria-keyshortcuts` text for a key, e.g. `"Escape"` -> `"Escape"`,
 *  `" "` -> `"Space"`, `"m"` -> `"M"`. A plain letter or digit passes through
 *  uppercased, matching this file's own key spelling convention (`SHORTCUTS` always
 *  declares letters in upper case). Every call site that sets `aria-keyshortcuts` on an
 *  owning control uses this, never `kbdGlyph`. */
export function ariaKeyshortcut(key: string): string {
  return ARIA_TOKENS[key] ?? key.toUpperCase();
}
