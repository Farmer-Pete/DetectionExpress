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
 * control, one with a negative `tabIndex`, or one sitting inside an
 * `aria-hidden`, `hidden`, or `inert` subtree, is excluded even though it
 * matches the selector above. The `tabIndex < 0` guard matters for the native
 * controls (`button`, `input`, ...) the selector matches unconditionally: a
 * roving-tabindex tab strip marks its inactive tabs `tabIndex={-1}`, so they
 * are focusable by script but out of the Tab order — the trap must skip them,
 * or it would treat an inactive tab as an edge control and let Tab escape.
 */
export function focusableControls(dialog: HTMLElement): HTMLElement[] {
  return [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
    (el) =>
      el.tabIndex >= 0 &&
      !el.matches(":disabled") &&
      el.closest('[aria-hidden="true"], [hidden], [inert]') === null,
  );
}

/** The subset of a keyboard event `trapTab` reads: `event.key`, so it can no-op
 *  on anything but Tab, plus the two fields it needs to wrap focus. Structural,
 *  not a React import, so both a real `KeyboardEvent` and React's synthetic one
 *  satisfy it without a cast. */
interface TabKeyEvent {
  key: string;
  shiftKey: boolean;
  preventDefault: () => void;
}

/**
 * Wrap Tab/Shift+Tab at `dialog`'s edges, keeping focus inside it. Call this
 * after a caller's own Escape branch, on every keydown; it no-ops (and returns
 * `false`) on any key but Tab, or when the dialog carries no focusable control.
 * Wraps both when focus sits exactly on the first/last control AND when it
 * sits outside every control (`!inControls`, e.g. the dialog container itself,
 * right after open-focus lands there before any control takes it). Returns
 * whether it intercepted the key, so a caller never needs its own duplicate
 * Tab check.
 */
export function trapTab(dialog: HTMLElement, event: TabKeyEvent): boolean {
  if (event.key !== "Tab") {
    return false;
  }
  const controls = focusableControls(dialog);
  const first = controls[0];
  const last = controls[controls.length - 1];
  if (first === undefined || last === undefined) {
    return false;
  }
  const active = document.activeElement;
  const inControls = controls.some((control) => control === active);
  if (event.shiftKey && (active === first || !inControls)) {
    event.preventDefault();
    last.focus();
    return true;
  }
  if (!event.shiftKey && (active === last || !inControls)) {
    event.preventDefault();
    first.focus();
    return true;
  }
  return false;
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
 * "Outside" means the backdrop SCRIM wrapping the dialog — the dialog's parent, a
 * full-viewport fixed overlay — NOT anywhere in the document. Scoping to the scrim is
 * what stops the very click that OPENED the dialog from dismissing it: that opening
 * click lands on shell content (e.g. the findings row that set the selection), which
 * sits in a separate subtree from the scrim, yet still bubbles up to this document-level
 * `click` listener in the SAME dispatch — because the open-effect adds the listener
 * mid-bubble, below `document` in the tree. A document-wide "anywhere the dialog does not
 * contain" test treated that opening click as an outside click and dismissed the dialog
 * on the same gesture that opened it, so it never appeared. (Synthetic clicks —
 * happy-dom `fireEvent`, headless drivers — fire fully before the effect installs the
 * listener, so they never hit this; only a real user click did.)
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
    if (dialog === null || !(target instanceof Node)) {
      return false;
    }
    const scrim = dialog.parentElement;
    if (scrim === null) {
      return false;
    }
    return scrim.contains(target) && !dialog.contains(target);
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
