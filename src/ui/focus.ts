/**
 * Shared modal-dialog plumbing: the focus trap `IntroOverlay` and `TraceOverlay`
 * both wrap Tab/Shift+Tab with, and the outside-pointer dismissal both wire to
 * their backdrop. This is the one place that logic lives, so the two never
 * drift apart.
 */
import type { RefObject } from "react";

/** The standard focusable set, so the trap survives controls added later. */
const FOCUSABLE_SELECTOR =
  'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * A dialog's focusable controls, in DOM order. Attribute-only checks (no
 * `offsetWidth`/`getClientRects`, which happy-dom never lays out): a disabled
 * control, or one sitting inside an `aria-hidden`, `hidden`, or `inert`
 * subtree, is excluded even though it matches the selector above.
 */
export function focusableControls(dialog: HTMLElement): HTMLElement[] {
  return [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
    (el) =>
      !el.matches(":disabled") && el.closest('[aria-hidden="true"], [hidden], [inert]') === null,
  );
}

/**
 * Dismiss a dialog on a genuine outside click, never on a gesture that merely
 * ENDS outside it (e.g. selecting text inside the dialog and releasing the
 * mouse over the backdrop) — and, symmetrically, never on a gesture that
 * merely STARTS outside it (e.g. a mis-click on the backdrop that slides onto
 * the dialog before release). A `pointerdown` and a `pointerup` each record
 * whether THEY landed outside the dialog; the paired `click` only dismisses
 * when the click itself landed outside AND neither recorded endpoint says it
 * was inside. A gesture with either endpoint inside the dialog never
 * dismisses. Each new pointerdown/pointerup overwrites its own remembered
 * value, so only the click's own gesture is ever consulted.
 *
 * happy-dom's `fireEvent.click` fires no paired `pointerdown`/`pointerup` at
 * all, so with neither recorded since install the check falls back to the
 * click target alone (outside-agnostic) — this keeps a plain backdrop-click
 * test green without synthesized pointer events, while a real drag that
 * starts or ends inside the dialog still stays open.
 *
 * Returns a cleanup that removes all three listeners.
 */
export function installOutsidePointerDismiss(
  dialogRef: RefObject<HTMLElement | null>,
  onDismiss: () => void,
): () => void {
  // undefined: no pointerdown/pointerup recorded since install.
  let pointerDownOutside: boolean | undefined;
  let pointerUpOutside: boolean | undefined;

  const isOutside = (target: EventTarget | null): boolean => {
    const dialog = dialogRef.current;
    return dialog !== null && target instanceof Node && !dialog.contains(target);
  };

  const onPointerDown = (event: PointerEvent): void => {
    pointerDownOutside = isOutside(event.target);
  };

  const onPointerUp = (event: PointerEvent): void => {
    pointerUpOutside = isOutside(event.target);
  };

  const onClick = (event: MouseEvent): void => {
    const clickOutside = isOutside(event.target);
    if (
      clickOutside &&
      (pointerDownOutside === undefined || pointerDownOutside) &&
      (pointerUpOutside === undefined || pointerUpOutside)
    ) {
      onDismiss();
    }
  };

  document.addEventListener("pointerdown", onPointerDown);
  document.addEventListener("pointerup", onPointerUp);
  document.addEventListener("click", onClick);
  return () => {
    document.removeEventListener("pointerdown", onPointerDown);
    document.removeEventListener("pointerup", onPointerUp);
    document.removeEventListener("click", onClick);
  };
}
