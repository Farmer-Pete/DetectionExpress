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
  /** Fallback focus target for a close-all whose root trigger has since left the
   *  document. */
  fallbackFocusRef: RefObject<HTMLElement | null>;
  /** Shared with the OTHER dialog (owned by App): the element that triggered the
   *  current dialog-stack session's very first, "outside", open. Captured once per
   *  session (guarded by `.current === null`, so a pop back down to a single entry
   *  never overwrites it with a bogus mid-stack value) and consumed once the stack
   *  empties. */
  rootTriggerRef: RefObject<Element | null>;
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
}: MapDialogFocusArgs): void {
  useEffect(() => {
    if (!isTop) {
      return;
    }
    if (stackLength === 1 && rootTriggerRef.current === null) {
      rootTriggerRef.current = document.activeElement;
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
      rootTriggerRef.current = null; // consumed; the next root open captures fresh
      if (trigger instanceof HTMLElement && trigger.isConnected) {
        trigger.focus();
      } else {
        fallbackFocusRef.current?.focus();
      }
    };
  }, [isTop, stackLength, dialogRef, fallbackFocusRef, rootTriggerRef]);
}
