/**
 * GH137-PLAN.md: the shortcuts provider. Owns `activeScope` (derived from `App`'s own
 * state, not an imperative mount stack) and the one `window` `keydown` dispatcher that
 * fires a control's registered handler. `use-shortcut.ts` is the only other module that
 * talks to this one; every control goes through it, never through this file directly.
 *
 * ## `activeScope` is derived, not pushed/popped
 * `App` already owns the state that decides which surface is on screen (`traceOpen`,
 * the map-dialog stack's top kind, `legendOpen`, the side panel's open+tab, and
 * `hireMeOpen`, lifted into `App` in M2). `resolveActiveScope` is a pure function of
 * exactly that state, so there is one source of truth and no lifecycle-ordering hazard
 * (the alternative, a mount-driven push/pop stack, breaks under Strict Mode's
 * double-invoke and any out-of-order cleanup). When more than one flag is briefly true
 * it applies a fixed precedence, highest first: `trace` > `mapDialog:*` > `legend` >
 * `sidepanel:*` > `hireMe` > `shell`. `App` already keeps trace, the side panel, the
 * map dialog, and the legend mutually exclusive, so the only real overlap this
 * precedence has to settle is `hireMeOpen` against one of the other four.
 *
 * ## Commit-fresh reads
 * The dispatcher is one long-lived listener, so it must never read a stale
 * `activeScope` or a stale handler map from an old render's closure. Both live in refs,
 * updated in a `useLayoutEffect` that runs after every commit — the listener reads only
 * the refs, so a shortcut fired immediately after an open, a close, or a tab change sees
 * the just-committed state, not last render's.
 *
 * ## Registration mirrors real operability
 * `register` is keyed by `(scope, key.toLowerCase())` — case-insensitive, so `Shift+M`
 * dispatches the same entry as `m`. It refuses a `RESERVED` key or a `dispatch: false`
 * entry outright (the key already has an owner — Space/LogPanel, Escape/`focus.ts`, the
 * arrows/roving-tabs or driver.js — so this file must never take it over); it just skips
 * setting up a live handler; `use-shortcut.ts` still gets `{key, label}` back to render
 * the badge.
 *
 * Each `(scope, key)` holds a STACK of registrations, not a single entry (code review
 * MINOR fix): `register` pushes, the dispatcher always fires the top (most-recent)
 * entry, and the unregister a caller's cleanup runs removes only ITS OWN entry — if that
 * was the top and others remain, the next one down becomes live again, and the key is
 * only removed once the stack is empty. The single-entry version used to lose an older,
 * still-mounted control's handler entirely once a newer one unregistered, because
 * deleting "the entry for this key" and deleting "my entry" were the same operation. A
 * genuine duplicate live registration — the SAME `id` registered twice without an
 * intervening unregister, which the static `SHORTCUTS` table cannot catch on its own —
 * still throws in dev/test (`import.meta.env.DEV`, true in both): that is a caller bug
 * (a leaked registration, or two mounted instances of what should be a singleton
 * control), unlike two DIFFERENT ids legitimately sharing a key's stack. Production
 * never throws either way, so a real player's session can't crash over it.
 *
 * ## The dispatcher's six checks, in order
 * 1. `tourOwnsKeyboard.current` -> bail (driver.js owns the keyboard while the guided
 *    tour drives).
 * 2. `ctrlKey`/`metaKey`/`altKey` held -> bail (never shadow a browser shortcut).
 * 3. `event.repeat` -> bail (a held key must not re-fire).
 * 4. `event.defaultPrevented` -> bail (a prior handler already consumed this keydown).
 * 5. `isTextEntry(event.target)` -> bail (never fight typing; a focused radio is NOT
 *    text entry, so it does not suppress a mnemonic — see `text-entry.ts`).
 * 6. look up `(activeScope, event.key.toLowerCase())`; if a live, enabled entry exists,
 *    `preventDefault()` and invoke it.
 *
 * `Space`/`Escape`/the arrows are never dispatched here at all (refused at registration,
 * per the invariant above), so there is no double-handling with LogPanel's own Space
 * listener, `focus.ts`'s Escape, the side-panel tab arrows, or driver.js.
 *
 * ## The WCAG 2.1.4 off-switch (GH137-PLAN.md code review fix 4)
 * `shortcutsEnabled` (default `true`) is the player's persisted "turn off" preference
 * for single-character shortcuts (`shortcuts-preference.ts`; `App.tsx` owns the state
 * and the read/write). It covers exactly the shortcuts WCAG 2.1.4 requires an
 * off-switch for: global, unmodified single-character mnemonics dispatched from this
 * one `window` listener regardless of what has focus (M, T, P, R, A, F, L, H, B, O,
 * the digit speeds). Escape/the arrows are exempt — WCAG 2.1.4 excuses a shortcut
 * "only active when a particular user interface component has focus", and every one
 * of those is scoped to whichever dialog/tablist owns it, handled by that
 * component's own `onKeyDown`, never through this dispatcher at all (they are
 * RESERVED/`dispatch: false` for exactly that reason). Freeze's Space is the one
 * exception needing its own bail (`LogPanel.tsx`): it is genuinely global, but
 * dispatched through LogPanel's own `window` listener, not this one, since Space
 * already has that owner.
 *
 * While `false`: `register` refuses every call outright (mirroring the RESERVED/
 * `dispatch: false` refusal above), so nothing is EVER live-registered, and the
 * dispatcher's keydown handler bails first, before any of its six checks, as a second,
 * independent guard against a stale/leaked registration. `useShortcut` (the only
 * caller of `register`) additionally skips calling it at all while `false` (belt and
 * suspenders: the effect's own dependency array includes the live `enabled` context
 * value, so a toggle re-runs it), and returns `key: undefined` — every consuming
 * control already renders its `<Kbd>` badge and `aria-keyshortcuts` conditionally on
 * `key !== undefined`, so one flag suppresses every badge in the app without touching
 * each control.
 */
import {
  createContext,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import type { SidePanelTab } from "../sidepanel/SidePanel";
import { RESERVED, type Scope, type ShortcutDef } from "./shortcuts.data";
import { isTextEntry } from "./text-entry";

/** The slice of `App`'s own state `resolveActiveScope` needs to pick the one active
 *  surface. */
export interface ShortcutsAppState {
  traceOpen: boolean;
  mapDialogKind: "event" | "place" | null;
  legendOpen: boolean;
  sidePanelOpen: boolean;
  sidePanelTab: SidePanelTab;
  hireMeOpen: boolean;
}

/** The single topmost complete surface, or `"shell"` when nothing is open. Pure — see
 *  the module doc for the fixed precedence order: `trace` > `mapDialog:*` > `legend` >
 *  `sidepanel:*` > `hireMe` > `shell`. */
export function resolveActiveScope(appState: ShortcutsAppState): Scope {
  if (appState.traceOpen) {
    return "trace";
  }
  if (appState.mapDialogKind !== null) {
    return `mapDialog:${appState.mapDialogKind}`;
  }
  if (appState.legendOpen) {
    return "legend";
  }
  if (appState.sidePanelOpen) {
    return `sidepanel:${appState.sidePanelTab}`;
  }
  if (appState.hireMeOpen) {
    return "hireMe";
  }
  return "shell";
}

interface RegistrationEntry {
  /** The registering control's own `ShortcutDef.id`, so a genuine duplicate (the SAME
   *  id registered twice while still live) can be told apart from two DIFFERENT ids
   *  legitimately stacked on the same key. */
  id: string;
  handler: () => void;
  enabled: boolean;
}

/** `use-shortcut.ts`'s only door into this file: register a control's handler for
 *  `(scope, def.key)`, or refuse (see the module doc), and get an unregister back. */
type Register = (
  scope: Scope,
  def: ShortcutDef,
  handler: () => void,
  enabled: boolean,
) => () => void;

const noopUnregister = (): void => {};
const noopRegister: Register = () => noopUnregister;

interface ShortcutsContextValue {
  register: Register;
  /** The WCAG 2.1.4 off-switch (module doc). Defaults `true` (enabled) so a bare
   *  control (an isolated component test rendered with no `ShortcutsProvider`) keeps
   *  rendering its badge exactly as before this feature existed. */
  enabled: boolean;
}

const ShortcutsContext = createContext<ShortcutsContextValue>({
  register: noopRegister,
  enabled: true,
});

/** `use-shortcut.ts`'s accessor. Defaults to a no-op registration when no
 *  `ShortcutsProvider` is mounted (an isolated component test renders the control bare),
 *  so a bare control still renders its badge data without needing to register a real
 *  handler. */
export function useShortcutsRegister(): Register {
  return useContext(ShortcutsContext).register;
}

/** `use-shortcut.ts`'s accessor for the WCAG 2.1.4 off-switch (module doc). A live
 *  React value (not a ref): consumers must re-render when it flips, so their badge
 *  and their registration effect both react to a toggle, not just to their own next
 *  mount. */
export function useShortcutsEnabled(): boolean {
  return useContext(ShortcutsContext).enabled;
}

export interface ShortcutsProviderProps {
  /** The state `resolveActiveScope` reads, owned by `App`. */
  appState: ShortcutsAppState;
  /** The synchronous "the tour owns the keyboard" flag (module doc). Owned by `App` and
   *  shared with `useTour`; defaults to a locally-owned ref (always `false`), so a bare
   *  provider — an isolated test with no tour in the tree — still works. */
  tourOwnsKeyboardRef?: RefObject<boolean> | undefined;
  /** The WCAG 2.1.4 off-switch (module doc): the player's persisted "turn off"
   *  preference. Defaults `true` (enabled), so a bare provider — an isolated test
   *  that never passes it — dispatches exactly as it did before this feature
   *  existed. `App.tsx` owns the state (`shortcuts-preference.ts`) and passes it
   *  through here. */
  shortcutsEnabled?: boolean | undefined;
  children: ReactNode;
}

export function ShortcutsProvider({
  appState,
  tourOwnsKeyboardRef: externalTourRef,
  shortcutsEnabled = true,
  children,
}: ShortcutsProviderProps) {
  const ownTourRef = useRef(false);
  const tourOwnsKeyboardRef = externalTourRef ?? ownTourRef;
  // Commit-fresh read for the KEYDOWN LISTENER only (module doc "Commit-fresh reads"):
  // a real keyboard event always arrives after every effect from the triggering commit
  // has already flushed, so a ref refreshed in a `useLayoutEffect` below is safe there.
  // `register`, below, must NOT use this ref: React commits a CHILD's layout effects
  // (e.g. `useShortcut`'s own registration effect) before this PROVIDER's, so on the
  // very commit that flips `shortcutsEnabled`, a child's effect would call `register`
  // before this ref had a chance to catch up. `register` instead closes over the
  // `shortcutsEnabled` prop directly (its own `useCallback` depends on it), which is
  // already the current render's value the moment `register` is (re)created — no
  // ordering hazard.
  const shortcutsEnabledRef = useRef(shortcutsEnabled);

  // Registrations live in a ref, mutated directly by `register`/its returned
  // unregister — never React state, so a control mounting or unmounting never forces
  // this provider to re-render. Nested `Map`s: scope -> lowercased key -> a STACK of
  // entries (module doc: "Registration mirrors real operability"). The dispatcher
  // always reads the last (most-recent) entry.
  const handlersRef = useRef<Map<Scope, Map<string, RegistrationEntry[]>>>(new Map());
  // The one source of truth for "which surface is active right now", refreshed in the
  // layout effect below on every commit (module doc: "commit-fresh reads").
  const activeScopeRef = useRef<Scope>(resolveActiveScope(appState));

  const register = useCallback<Register>(
    (scope, def, handler, enabled) => {
      // WCAG 2.1.4 off-switch (module doc): reads the PROP directly, not a ref — this
      // callback is recreated (via the `[shortcutsEnabled]` dep below) whenever the
      // preference changes, so it always closes over the current render's value the
      // instant it exists, with no ordering hazard against a child's own layout effect
      // in the same commit (see the `shortcutsEnabledRef` comment above).
      if (!shortcutsEnabled) {
        return noopUnregister; // register nothing while OFF
      }
      if (RESERVED.has(def.key) || def.dispatch === false) {
        return noopUnregister; // the key already has an owner; never take over its dispatch
      }
      const normalizedKey = def.key.toLowerCase();
      let scopeMap = handlersRef.current.get(scope);
      if (scopeMap === undefined) {
        scopeMap = new Map<string, RegistrationEntry[]>();
        handlersRef.current.set(scope, scopeMap);
      }
      const liveScopeMap = scopeMap;
      let stack = liveScopeMap.get(normalizedKey);
      if (stack === undefined) {
        stack = [];
        liveScopeMap.set(normalizedKey, stack);
      }
      const liveStack = stack;
      // A genuine duplicate: the SAME id already live on this stack, never unregistered —
      // a caller bug (a leaked registration, or two mounted instances of what should be a
      // singleton control). Two DIFFERENT ids sharing a key legitimately stack instead
      // (module doc): e.g. a control mid-transition whose replacement has already
      // registered before its own cleanup runs.
      if (import.meta.env.DEV && liveStack.some((entry) => entry.id === def.id)) {
        throw new Error(
          `useShortcut: duplicate live registration for scope "${scope}", key "${def.key}" ` +
            `(id "${def.id}"). The same control registered twice without unregistering first.`,
        );
      }
      const entry: RegistrationEntry = { id: def.id, handler, enabled };
      liveStack.push(entry);
      return () => {
        const index = liveStack.indexOf(entry);
        if (index === -1) {
          return;
        }
        liveStack.splice(index, 1);
        if (liveStack.length === 0) {
          liveScopeMap.delete(normalizedKey);
        }
      };
    },
    [shortcutsEnabled],
  );

  const activeScope = resolveActiveScope(appState);
  useLayoutEffect(() => {
    activeScopeRef.current = activeScope;
  }, [activeScope]);

  useLayoutEffect(() => {
    shortcutsEnabledRef.current = shortcutsEnabled;
  }, [shortcutsEnabled]);

  useLayoutEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!shortcutsEnabledRef.current) {
        return; // WCAG 2.1.4 off-switch: dispatch nothing while OFF
      }
      if (tourOwnsKeyboardRef.current) {
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey) {
        return;
      }
      if (event.repeat) {
        return;
      }
      if (event.defaultPrevented) {
        return;
      }
      if (isTextEntry(event.target)) {
        return;
      }
      const stack = handlersRef.current.get(activeScopeRef.current)?.get(event.key.toLowerCase());
      const entry = stack?.[stack.length - 1]; // the top (most-recent) registration
      if (entry === undefined || !entry.enabled) {
        return;
      }
      event.preventDefault();
      entry.handler();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [tourOwnsKeyboardRef]);

  const value = useMemo<ShortcutsContextValue>(
    () => ({ register, enabled: shortcutsEnabled }),
    [register, shortcutsEnabled],
  );

  return <ShortcutsContext.Provider value={value}>{children}</ShortcutsContext.Provider>;
}
