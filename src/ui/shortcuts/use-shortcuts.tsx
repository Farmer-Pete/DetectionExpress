/**
 * GH137-PLAN.md: the shortcuts provider. Owns `activeScope` (derived from `App`'s own
 * state, not an imperative mount stack) and the one `window` `keydown` dispatcher that
 * fires a control's registered handler. `use-shortcut.ts` is the only other module that
 * talks to this one; every control goes through it, never through this file directly.
 *
 * ## `activeScope` is derived, not pushed/popped
 * `App` already owns the state that decides which surface is on screen (`traceOpen`,
 * the map-dialog stack's top kind, the side panel's open+tab, and — from M2, once Hire
 * Me is lifted — `hireMeOpen`). `resolveActiveScope` is a pure function of exactly that
 * state, so there is one source of truth and no lifecycle-ordering hazard (the
 * alternative, a mount-driven push/pop stack, breaks under Strict Mode's double-invoke
 * and any out-of-order cleanup). When more than one flag is briefly true it applies a
 * fixed precedence, highest first: `trace` > `mapDialog:*` > `sidepanel:*` > `hireMe` >
 * `shell`. `App` already keeps trace, the side panel, and the map dialog mutually
 * exclusive, so the only real overlap this precedence has to settle is `hireMeOpen`
 * against one of the other three.
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
 * the badge. A genuine duplicate LIVE registration of the same `(scope, key)` — two
 * mounted controls both claiming it, which the static `SHORTCUTS` table cannot catch on
 * its own — throws in dev/test (`import.meta.env.DEV`, true in both) instead of silently
 * overwriting a handler; production silently keeps the newest registration, so a real
 * player's session never crashes over it.
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
 *  surface. M1 note: `hireMeOpen` is always `false` from `App.tsx` this milestone — Hire
 *  Me still owns its `open` state privately; it is lifted into `App` in M2. */
export interface ShortcutsAppState {
  traceOpen: boolean;
  mapDialogKind: "event" | "place" | null;
  sidePanelOpen: boolean;
  sidePanelTab: SidePanelTab;
  hireMeOpen: boolean;
}

/** The single topmost complete surface, or `"shell"` when nothing is open. Pure — see
 *  the module doc for the fixed precedence order. */
export function resolveActiveScope(appState: ShortcutsAppState): Scope {
  if (appState.traceOpen) {
    return "trace";
  }
  if (appState.mapDialogKind !== null) {
    return `mapDialog:${appState.mapDialogKind}`;
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
}

const ShortcutsContext = createContext<ShortcutsContextValue>({ register: noopRegister });

/** `use-shortcut.ts`'s accessor. Defaults to a no-op registration when no
 *  `ShortcutsProvider` is mounted (an isolated component test renders the control bare),
 *  so a bare control still renders its badge data without needing to register a real
 *  handler. */
export function useShortcutsRegister(): Register {
  return useContext(ShortcutsContext).register;
}

export interface ShortcutsProviderProps {
  /** The state `resolveActiveScope` reads, owned by `App`. */
  appState: ShortcutsAppState;
  /** The synchronous "the tour owns the keyboard" flag (module doc). Owned by `App` and
   *  shared with `useTour`; defaults to a locally-owned ref (always `false`), so a bare
   *  provider — an isolated test with no tour in the tree — still works. */
  tourOwnsKeyboardRef?: RefObject<boolean> | undefined;
  children: ReactNode;
}

export function ShortcutsProvider({
  appState,
  tourOwnsKeyboardRef: externalTourRef,
  children,
}: ShortcutsProviderProps) {
  const ownTourRef = useRef(false);
  const tourOwnsKeyboardRef = externalTourRef ?? ownTourRef;

  // Registrations live in a ref, mutated directly by `register`/its returned
  // unregister — never React state, so a control mounting or unmounting never forces
  // this provider to re-render. Nested `Map`s: scope -> lowercased key -> entry.
  const handlersRef = useRef<Map<Scope, Map<string, RegistrationEntry>>>(new Map());
  // The one source of truth for "which surface is active right now", refreshed in the
  // layout effect below on every commit (module doc: "commit-fresh reads").
  const activeScopeRef = useRef<Scope>(resolveActiveScope(appState));

  const register = useCallback<Register>((scope, def, handler, enabled) => {
    if (RESERVED.has(def.key) || def.dispatch === false) {
      return noopUnregister; // the key already has an owner; never take over its dispatch
    }
    const normalizedKey = def.key.toLowerCase();
    let scopeMap = handlersRef.current.get(scope);
    if (scopeMap === undefined) {
      scopeMap = new Map<string, RegistrationEntry>();
      handlersRef.current.set(scope, scopeMap);
    }
    const liveScopeMap = scopeMap;
    if (import.meta.env.DEV && liveScopeMap.has(normalizedKey)) {
      throw new Error(
        `useShortcut: duplicate live registration for scope "${scope}", key "${def.key}". ` +
          "Two mounted controls are both claiming the same shortcut.",
      );
    }
    const entry: RegistrationEntry = { handler, enabled };
    liveScopeMap.set(normalizedKey, entry);
    return () => {
      if (liveScopeMap.get(normalizedKey) === entry) {
        liveScopeMap.delete(normalizedKey);
      }
    };
  }, []);

  const activeScope = resolveActiveScope(appState);
  useLayoutEffect(() => {
    activeScopeRef.current = activeScope;
  }, [activeScope]);

  useLayoutEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
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
      const entry = handlersRef.current.get(activeScopeRef.current)?.get(event.key.toLowerCase());
      if (entry === undefined || !entry.enabled) {
        return;
      }
      event.preventDefault();
      entry.handler();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [tourOwnsKeyboardRef]);

  const value = useMemo<ShortcutsContextValue>(() => ({ register }), [register]);

  return <ShortcutsContext.Provider value={value}>{children}</ShortcutsContext.Provider>;
}
