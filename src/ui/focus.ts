/**
 * Shared focus-trap plumbing for a modal dialog: the standard focusable
 * selector and a helper to collect a container's focusable controls in DOM
 * order. `IntroOverlay` and `TraceOverlay` both wrap Tab/Shift+Tab at these
 * edges to keep focus inside their dialog; this is the one place that logic
 * lives, so the two never drift apart.
 */

/** The standard focusable set, so the trap survives controls added later. */
const FOCUSABLE_SELECTOR =
  'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** A dialog's focusable controls, in DOM order. */
export function focusableControls(dialog: HTMLElement): HTMLElement[] {
  return [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)];
}
