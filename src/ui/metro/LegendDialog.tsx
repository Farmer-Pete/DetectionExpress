/**
 * The mobile legend dialog (GH133-PLAN.md): the floating chip's standalone modal,
 * opened while `App`'s `legendOpen` is true. This is deliberately NOT
 * `MapDialogShell`: that shell's close, Back, and focus restore are bound to the
 * store's `mapDialogStack` — Escape/backdrop/Close there call `clearMapDialogStack()`,
 * which would clear an empty map stack and leave `legendOpen` stuck true (Codex round
 * 2 MAJOR). So this dialog is a small standalone component built on the same shared
 * focus primitives `MapDialogShell` and `TraceOverlay` already use (`trapTab`,
 * `installOutsidePointerDismiss`, `focus.ts`), with its own open-focus and
 * close-restore, and no stack of its own.
 *
 * It renders `LegendSections` (the same Lines/Actors/Sensors content the desktop rail
 * shows, `MetroView.tsx`'s `MetroKey`) — the two never render at once, since the rail
 * is CSS-hidden below 720px and this dialog only mounts while `legendOpen`.
 *
 * Focus restore uses the explicit `triggerRef` App passes in (the chip button),
 * NOT a captured `document.activeElement` (Codex round 2): a pointer activation that
 * never focused the chip must still restore focus there on close.
 */
import { type KeyboardEvent, type RefObject, useEffect, useRef } from "react";
import { installOutsidePointerDismiss, trapTab } from "../focus";
import { LegendSections } from "./LegendSections";

interface LegendDialogProps {
  /** Called on Escape, a backdrop/outside click, or the close button. App clears
   *  `legendOpen` in response; this component holds no open state of its own. */
  onClose: () => void;
  /** The chip that opened this dialog (`MetroView.tsx`'s `.metro-legend-button`,
   *  owned by App). Focus restores here on unmount, regardless of what actually held
   *  focus at open time. */
  triggerRef: RefObject<HTMLElement | null>;
}

export function LegendDialog({ onClose, triggerRef }: LegendDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  // Move focus into the dialog on mount; restore it to the trigger ref on unmount.
  // This component only ever mounts while `legendOpen`, so "mount"/"unmount" IS
  // "open"/"close" here — unlike `MapDialogShell`, there is no isTop flag to track.
  useEffect(() => {
    dialogRef.current?.focus();
    return () => {
      triggerRef.current?.focus();
    };
  }, [triggerRef]);

  // A genuine outside click on the backdrop scrim dismisses, mirroring
  // `MapDialogShell`/`TraceOverlay`.
  useEffect(() => {
    return installOutsidePointerDismiss(dialogRef, onClose);
  }, [onClose]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    const dialog = dialogRef.current;
    if (dialog === null) {
      return;
    }
    trapTab(dialog, event);
  };

  return (
    <div className="legend-dialog-backdrop">
      <div
        ref={dialogRef}
        className="legend-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Legend"
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <header className="legend-dialog-header">
          <span className="legend-dialog-title">Legend</span>
          <button
            type="button"
            className="legend-dialog-close"
            aria-label="Close"
            onClick={onClose}
          >
            <span aria-hidden="true">×</span>
          </button>
        </header>
        <div className="legend-dialog-body">
          <LegendSections />
        </div>
      </div>
    </div>
  );
}
