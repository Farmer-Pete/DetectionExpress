/**
 * Shared focus-restore plumbing for the map/event dialog stack (`PlaceDialog.tsx`,
 * `EventDialog.tsx`, GH124 follow-up: the dialog navigation stack). Pushing a second
 * dialog on top of the first must not touch focus restoration at all — the newly
 * topmost dialog just takes focus for itself — while a FULL close (the stack
 * draining to empty) must restore focus to whatever triggered the very first,
 * "outside", open of this stack session, not to whatever a pushed dialog's own local
 * `document.activeElement` capture would see. That local capture is never the real
 * external trigger for a pushed dialog anyway: the shell stays `inert` for as long as
 * ANY entry remains on the stack, and a still-inert element can never receive focus,
 * so a mid-stack capture only ever sees whatever residual, un-useful target focus
 * fell back to (in practice `document.body`).
 *
 * So the "root trigger" is captured ONCE, in a ref shared by both dialogs (owned by
 * `App`, handed to each as `rootTriggerRef`), the moment the stack goes from empty to
 * its first entry, and consumed (nulled out) the moment the stack drains back to
 * empty — regardless of which of the two dialog KINDS happens to be on top at either
 * end. A Back (pop, stack stays non-empty) or a push (stack grows) both move focus
 * into whichever dialog is now on top, via that dialog's own `dialogRef`, without
 * touching the root trigger at all.
 *
 * The FALLBACK for when that root trigger has since left the document is captured the
 * same way, in the same instant, in a second ref also shared by both dialogs
 * (`rootFallbackFocusRef`) — not read fresh from whichever dialog's own
 * `fallbackFocusRef` happens to be on top at close time. An event-rooted session (a
 * log-row click) that pushes a place dialog on top must restore to the EVENT's
 * fallback (the log panel) on a full close, even though the place dialog — with its
 * own fallback, the map region — is what's actually on screen when the close
 * happens. Reading the topmost dialog's own `fallbackFocusRef` at close time would
 * restore to whichever dialog happens to be on top, which is the wrong element
 * whenever the stack closes on a dialog other than the one that rooted the session.
 */
import { type RefObject, useEffect } from "react";
import { useGameStore } from "../game/store";

export interface MapDialogFocusArgs {
  /** True while THIS dialog is the stack's top entry, i.e. it is the one rendering. */
  isTop: boolean;
  /** The stack's length at the moment this effect (re-)runs — read once per open or
   *  reveal, not derived fresh on every render. */
  stackLength: number;
  /** This dialog's own root element: focused whenever it becomes (or stays) the top
   *  entry. */
  dialogRef: RefObject<HTMLElement | null>;
  /** THIS dialog's own fallback focus target, used only as the value captured into
   *  `rootFallbackFocusRef` when this dialog happens to be the one that roots the
   *  session — never read directly at close time (see the module doc above). */
  fallbackFocusRef: RefObject<HTMLElement | null>;
  /** Shared with the OTHER dialog (owned by App): the element that triggered the
   *  current dialog-stack session's very first, "outside", open. Captured once per
   *  session (guarded by `.current === null`, so a pop back down to a single entry
   *  never overwrites it with a bogus mid-stack value) and consumed once the stack
   *  empties. */
  rootTriggerRef: RefObject<Element | null>;
  /** Shared with the OTHER dialog (owned by App): the ROOT session's own
   *  `fallbackFocusRef`, captured in the same instant as `rootTriggerRef` above (same
   *  guard, same lifetime) so a full close always restores to the fallback of
   *  whichever dialog opened the session, not whichever one happens to be on top when
   *  it closes. */
  rootFallbackFocusRef: RefObject<RefObject<HTMLElement | null> | null>;
}

/**
 * Moves focus into `dialogRef` whenever this dialog becomes (or stays) the stack's
 * top entry, and restores it on a full close — see the module doc above for why a
 * push or a pop in between touches neither the capture nor the restore.
 */
export function useMapDialogFocus({
  isTop,
  stackLength,
  dialogRef,
  fallbackFocusRef,
  rootTriggerRef,
  rootFallbackFocusRef,
}: MapDialogFocusArgs): void {
  useEffect(() => {
    if (!isTop) {
      return;
    }
    if (stackLength === 1 && rootTriggerRef.current === null) {
      rootTriggerRef.current = document.activeElement;
      // Captured in the same instant, paired with the trigger above: THIS dialog is
      // the one rooting the session, so its own fallback is the session's fallback,
      // regardless of which dialog is on top when the session later closes.
      rootFallbackFocusRef.current = fallbackFocusRef;
    }
    dialogRef.current?.focus();
    return () => {
      // Read the CURRENT stack fresh, not the stale value this effect closed over:
      // the cleanup runs after the state change that triggered it, so this always
      // reflects the real post-transition stack.
      if (useGameStore.getState().mapDialogStack.length > 0) {
        return; // a push or a pop: the newly-visible dialog moves its own focus in
      }
      const trigger = rootTriggerRef.current;
      const rootFallback = rootFallbackFocusRef.current;
      rootTriggerRef.current = null; // consumed; the next root open captures fresh
      rootFallbackFocusRef.current = null;
      if (
        (trigger instanceof HTMLElement || trigger instanceof SVGElement) &&
        trigger.isConnected
      ) {
        // An SVGElement also implements `focus()`, so a map place control (an SVG
        // `<g>`, `MetroMap.tsx`) that rooted the session restores to itself, not the
        // fallback.
        trigger.focus();
      } else {
        // The ROOT session's fallback, not this dialog's own `fallbackFocusRef` — the
        // two only differ when the session closes on a dialog other than the one that
        // rooted it (see the module doc above).
        rootFallback?.current?.focus();
      }
    };
  }, [isTop, stackLength, dialogRef, fallbackFocusRef, rootTriggerRef, rootFallbackFocusRef]);
}
