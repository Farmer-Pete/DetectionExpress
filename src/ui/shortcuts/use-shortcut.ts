/**
 * GH137-PLAN.md: the per-control hook. A control calls this once, gets back
 * `{key, label}` to render its own `<Kbd>` badge and `aria-keyshortcuts`, and — unless
 * its entry is badge-only (`dispatch: false`) or its key is `RESERVED` — is registered
 * with `use-shortcuts.tsx`'s dispatcher for as long as it stays mounted and `enabled`.
 *
 * Returns data only, never JSX, so this stays a `.ts` file per the repo's own
 * `use-foo.ts(x)` convention (a hook that returns JSX is `.tsx`; this one does not). The
 * caller renders the badge itself with `<Kbd>`.
 *
 * `onActivate` is read through `useEffectEvent` (the same freshness technique
 * `tour/use-tour.ts`'s `autoStart` already uses), so a caller passing a fresh closure
 * every render — the common case — never causes a re-registration; only `scope`, the
 * looked-up `ShortcutDef`, or `enabled` changing does. `enabled` MUST track the same
 * predicate as the control's own `disabled`/visibility (e.g. a hidden tabpanel's
 * controls pass `enabled={activeTab === "..."}`), since it is re-read on every
 * registration and the dispatcher itself skips a disabled entry even if found.
 *
 * The WCAG 2.1.4 off-switch (GH137-PLAN.md code review fix 4, `use-shortcuts.tsx`'s own
 * module doc): while the player has turned shortcuts off, this returns `key: undefined`
 * regardless of what `SHORTCUTS` declares, and skips calling `register` at all. Every
 * consuming control already renders its `<Kbd>` badge and `aria-keyshortcuts`
 * conditionally on `key !== undefined` (the same branch that already covers "this id
 * names no entry"), so one flag here suppresses every badge/aria-keyshortcuts in the
 * app, with no change needed at any call site.
 */
import { useEffectEvent, useLayoutEffect } from "react";
import { type Scope, SHORTCUTS } from "./shortcuts.data";
import { useShortcutsEnabled, useShortcutsRegister } from "./use-shortcuts";

export interface UseShortcutArgs {
  scope: Scope;
  /** Matches a `ShortcutDef.id` declared for `scope` in `shortcuts.data.ts`. */
  id: string;
  onActivate: () => void;
  enabled: boolean;
}

export interface ShortcutBadge {
  /** The raw key, for `<Kbd shortcutKey={key} />` and `aria-keyshortcuts`. `undefined`
   *  when `id` names no entry in `scope`'s table (a caller bug — every wired id is
   *  declared), OR the player has turned shortcuts off (the WCAG 2.1.4 off-switch,
   *  module doc). */
  key: string | undefined;
  label: string;
}

export function useShortcut({ scope, id, onActivate, enabled }: UseShortcutArgs): ShortcutBadge {
  const register = useShortcutsRegister();
  const shortcutsEnabled = useShortcutsEnabled();
  const def = SHORTCUTS[scope].find((entry) => entry.id === id);

  const activate = useEffectEvent((): void => {
    onActivate();
  });

  useLayoutEffect(() => {
    if (def === undefined || !shortcutsEnabled) {
      return; // no entry, or the WCAG 2.1.4 off-switch is OFF: register nothing
    }
    return register(scope, def, activate, enabled);
    // `def` is a stable reference (SHORTCUTS is a module-level constant, `find` returns
    // the same object every render), so this effect re-runs only on a real scope/id/
    // enabled/shortcutsEnabled change — never on every render. `activate` (an Effect
    // Event) is intentionally omitted: its identity is always stable and it always
    // reads the latest `onActivate`, the same convention `tour/use-tour.ts`'s
    // `autoStart` uses.
  }, [register, scope, def, enabled, shortcutsEnabled]);

  return {
    key: shortcutsEnabled ? def?.key : undefined,
    label: def?.label ?? "",
  };
}
