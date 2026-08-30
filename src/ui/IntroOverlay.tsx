/**
 * The intro overlay: a first-load modal that introduces the simulation. It shows
 * the premise, two action buttons, and two links. Each action is wired by the App;
 * this component only renders and manages focus.
 *
 * It is a real modal dialog. It carries `role="dialog"` and `aria-modal="true"`,
 * takes its accessible name from its title, and moves focus inside on open. It wraps
 * Tab and Shift+Tab at the edges to keep focus within the dialog. Escape and a click
 * on the backdrop both dismiss it the way Observe does. The App restores focus to the
 * reopen control after the overlay unmounts.
 */
import { useEffect, useRef } from "react";
import type { IntroCopy } from "./content/narrative";

interface IntroOverlayProps {
  copy: IntroCopy;
  repoUrl: string;
  /** Dismiss only. Also fires on Escape and on a backdrop click. */
  onObserve: () => void;
  /** Dismiss, then scroll to the chaos ladder. */
  onCauseChaos: () => void;
  /** Dismiss, then scroll to the engine editor. */
  onEditEngine: () => void;
}

/** The standard focusable set, so the trap survives controls added later. */
const FOCUSABLE_SELECTOR =
  'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** The dialog's focusable controls, in DOM order. */
function focusableControls(dialog: HTMLElement): HTMLElement[] {
  return [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)];
}

export function IntroOverlay({
  copy,
  repoUrl,
  onObserve,
  onCauseChaos,
  onEditEngine,
}: IntroOverlayProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = "intro-overlay-title";

  // Move focus into the dialog on open, onto its first control.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) {
      return;
    }
    focusableControls(dialog)[0]?.focus();
  }, []);

  // A click outside the dialog, on the backdrop scrim, dismisses the way Observe
  // does. A click inside the dialog is contained, so it never dismisses. The listener
  // lives on the document, not on the scrim element, so the scrim stays a plain
  // presentational div.
  useEffect(() => {
    const onDocumentClick = (event: MouseEvent): void => {
      const dialog = dialogRef.current;
      if (dialog !== null && event.target instanceof Node && !dialog.contains(event.target)) {
        onObserve();
      }
    };
    document.addEventListener("click", onDocumentClick);
    return () => document.removeEventListener("click", onDocumentClick);
  }, [onObserve]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      onObserve();
      return;
    }
    if (event.key !== "Tab") {
      return;
    }
    const dialog = dialogRef.current;
    if (dialog === null) {
      return;
    }
    const controls = focusableControls(dialog);
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (first === undefined || last === undefined) {
      return;
    }
    // Wrap the two edges so focus stays inside the dialog.
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="intro-overlay-backdrop">
      <div
        ref={dialogRef}
        className="intro-overlay"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onKeyDown}
      >
        <h2 id={titleId} className="intro-overlay-title">
          {copy.title}
        </h2>
        {copy.paragraphs.map((paragraph) => (
          <p key={paragraph} className="intro-overlay-text">
            {paragraph}
          </p>
        ))}
        <p className="intro-overlay-invitation">{copy.invitation}</p>
        <div className="intro-overlay-actions">
          <button type="button" className="intro-overlay-observe" onClick={onObserve}>
            {copy.observeLabel}
          </button>
          <button type="button" className="intro-overlay-chaos" onClick={onCauseChaos}>
            {copy.chaosLabel}
          </button>
        </div>
        <div className="intro-overlay-links">
          <a
            className="intro-overlay-source"
            href={repoUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            {copy.sourceLabel}
          </a>
          <button type="button" className="intro-overlay-edit" onClick={onEditEngine}>
            {copy.editLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
