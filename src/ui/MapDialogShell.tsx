/**
 * The shared chrome for the map/event dialog stack (`metro/PlaceDialog.tsx`,
 * `log/EventDialog.tsx`). Both dialogs used to hand-roll the same backdrop, header,
 * Escape/Back/Close/backdrop/focus semantics, so a fix to one had to be copied to the
 * other by hand. This owns that chrome in one place; each dialog now supplies only its
 * own header slots (icon, title, meta) and its body as `children`.
 *
 * What this owns, identical for both dialogs:
 *   - the `.place-overlay-backdrop` scrim wrapping the dialog;
 *   - the `.place-overlay-header` with the "‹ Back" control (shown while the stack
 *     holds more than one entry, i.e. this dialog was pushed on top of another, and
 *     pops one entry), the caller's icon/title/meta slots, and the Close "×" control
 *     (always clears the whole stack);
 *   - `onKeyDown`: Escape pops one entry while a Back is available, else clears the
 *     whole stack, then `trapTab` wraps Tab/Shift+Tab at the dialog's edges;
 *   - the `installOutsidePointerDismiss` effect, so a genuine backdrop click clears
 *     the whole stack (the "give up and leave" gesture, never a Back);
 *   - the focus lifecycle via `useMapDialogFocus`: focus moves in when this dialog
 *     becomes the stack's top entry, and on a full close restores to the session's
 *     root trigger (else the root fallback). See `dialog-stack-focus.ts` for why the
 *     root trigger and its fallback are shared across both dialogs rather than
 *     captured independently by each.
 *
 * This mounts only while its dialog is the stack's top entry: each dialog returns null
 * before rendering the shell whenever it is not the top kind (see `PlaceDialog`/
 * `EventDialog`). So `isTop` is always true here, the backdrop is always on screen,
 * and the outside-dismiss effect needs no open-guard of its own. A push that swaps
 * which dialog is on top unmounts the hidden dialog's shell and mounts the newly-top
 * one's, so React runs the same focus cleanup and setup the always-mounted
 * `isTop`-flip did before, in the same commit and against the same shared refs. A pop
 * (Back) mounts the revealed dialog's shell fresh; the stack strictly alternates
 * place/event, so a given shell mount always sees a fixed `stackLength`.
 */
import { type KeyboardEvent, type ReactNode, type RefObject, useEffect, useRef } from "react";
import { useGameStore } from "../game/store";
import { useMapDialogFocus } from "./dialog-stack-focus";
import { installOutsidePointerDismiss, trapTab } from "./focus";
import { Kbd } from "./shortcuts/Kbd";
import type { Scope } from "./shortcuts/shortcuts.data";
import { ariaKeyshortcut } from "./shortcuts/shortcuts.data";
import { useShortcut } from "./shortcuts/use-shortcut";

interface MapDialogShellProps {
  /** Which `mapDialog:*` scope this instance's Back/Close shortcuts register under
   *  (GH137-PLAN.md M2) — `EventDialog`/`PlaceDialog` each pass their own. Narrowed to
   *  the `mapDialog:*` member of `Scope` (code review fix 1): this shell only ever
   *  registers under a map-dialog scope, so a caller passing `"shell"`/`"hireMe"`/etc.
   *  is a compile-time error instead of a silent runtime mismatch. */
  scope: Extract<Scope, `mapDialog:${string}`>;
  /** The dialog's accessible name (`aria-label`). Distinct from `title` because the
   *  event dialog labels itself "<sensor> reading" while its header shows just the
   *  sensor name. */
  ariaLabel: string;
  /** The header title text, rendered in `.place-overlay-title`. */
  title: string;
  /** The header icon element, already sized and colored by the caller, or nothing
   *  (the place dialog omits it for a place with no icon). */
  icon?: ReactNode;
  /** The header meta slot, rendered after the title: the place dialog's badges, or the
   *  event dialog's single timestamp badge. */
  meta?: ReactNode;
  /** Extra class(es) appended to `.place-overlay` (the event dialog adds
   *  `event-overlay`). */
  className?: string;
  /** The stack's length while this dialog is the top entry. A Back shows when it is
   *  more than one, and `useMapDialogFocus` reads it for the root-capture guard. */
  stackLength: number;
  /** Focus-restore fallback used only when THIS dialog roots the session (see
   *  `dialog-stack-focus.ts`). */
  fallbackFocusRef: RefObject<HTMLElement | null>;
  /** Shared across both dialogs (owned by `App`): the element that triggered the
   *  session's very first, "outside", open. */
  rootTriggerRef: RefObject<Element | null>;
  /** Shared across both dialogs (owned by `App`): the root session's own fallback,
   *  captured alongside `rootTriggerRef`. */
  rootFallbackFocusRef: RefObject<RefObject<HTMLElement | null> | null>;
  /** The dialog's body sections. */
  children: ReactNode;
}

export function MapDialogShell({
  ariaLabel,
  scope,
  title,
  icon,
  meta,
  className,
  stackLength,
  fallbackFocusRef,
  rootTriggerRef,
  rootFallbackFocusRef,
  children,
}: MapDialogShellProps) {
  const clearMapDialogStack = useGameStore((state) => state.clearMapDialogStack);
  const popMapDialog = useGameStore((state) => state.popMapDialog);

  // More than one entry means this dialog was pushed on top of another, so a "‹ Back"
  // can pop back to it. The stack's length is the single source for this rule now,
  // rather than each dialog re-deriving `> 1` on its own.
  const canGoBack = stackLength > 1;

  // GH137-PLAN.md M2: Back's `enabled` mirrors `canGoBack` above, the same predicate
  // that decides whether the button itself even renders. Close is badge-only.
  const { key: backKey } = useShortcut({
    scope,
    id: "back",
    onActivate: popMapDialog,
    enabled: canGoBack,
  });
  // Code review fix 2: Close's Escape badge/aria-keyshortcuts are only accurate while
  // there is no Back — `onKeyDown` below routes Escape to `popMapDialog` (Back), not
  // `clearMapDialogStack` (Close), whenever `canGoBack` is true. `enabled: !canGoBack`
  // mirrors that same routing predicate (this entry is badge-only regardless, since
  // Escape is RESERVED/dispatch:false — see `shortcuts.data.ts` — so `enabled` never
  // gates a live dispatch here, only keeps the two facts from drifting apart); the
  // render below additionally gates the badge/aria themselves on `!canGoBack`, since
  // `key` alone does not carry that condition.
  const { key: closeKey } = useShortcut({
    scope,
    id: "close",
    onActivate: () => {},
    enabled: !canGoBack,
  });

  const dialogRef = useRef<HTMLDivElement>(null);

  // Move focus into the dialog whenever it becomes (or stays) the stack's top entry;
  // restore it only on a full close, falling back when the root trigger has since left
  // the document. This shell mounts only while its dialog is the top entry, so `isTop`
  // is always true here. See `dialog-stack-focus.ts` for why a push or a pop touches
  // neither the capture nor the restore.
  useMapDialogFocus({
    isTop: true,
    stackLength,
    dialogRef,
    fallbackFocusRef,
    rootTriggerRef,
    rootFallbackFocusRef,
  });

  // A backdrop click always closes the WHOLE stack, not just this entry. It is the
  // "give up and leave" gesture, not a Back.
  useEffect(() => {
    return installOutsidePointerDismiss(dialogRef, clearMapDialogStack);
  }, [clearMapDialogStack]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      if (canGoBack) {
        popMapDialog();
      } else {
        clearMapDialogStack();
      }
      return;
    }
    const dialog = dialogRef.current;
    if (dialog === null) {
      return;
    }
    trapTab(dialog, event);
  };

  return (
    <div className="place-overlay-backdrop">
      <div
        ref={dialogRef}
        className={className === undefined ? "place-overlay" : `place-overlay ${className}`}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <header className="place-overlay-header">
          {canGoBack ? (
            <button
              type="button"
              className="place-overlay-back"
              aria-keyshortcuts={backKey === undefined ? undefined : ariaKeyshortcut(backKey)}
              onClick={popMapDialog}
            >
              <span aria-hidden="true">‹</span> Back
              {backKey !== undefined ? <Kbd shortcutKey={backKey} /> : null}
            </button>
          ) : null}
          {icon}
          <span className="place-overlay-title">{title}</span>
          {meta}
          <button
            type="button"
            className="place-overlay-close"
            aria-label="Close"
            aria-keyshortcuts={
              canGoBack || closeKey === undefined ? undefined : ariaKeyshortcut(closeKey)
            }
            onClick={clearMapDialogStack}
          >
            <span aria-hidden="true">×</span>
            {!canGoBack && closeKey !== undefined ? <Kbd shortcutKey={closeKey} /> : null}
          </button>
        </header>

        {children}
      </div>
    </div>
  );
}
