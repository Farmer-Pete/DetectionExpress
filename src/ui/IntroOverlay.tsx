/**
 * The intro overlay: a first-load modal that introduces the simulation. It shows
 * the premise, two action buttons, and two links. Each action is wired by the App;
 * this component only renders and manages focus.
 *
 * It is a real modal dialog. It carries `role="dialog"` and `aria-modal="true"`,
 * takes its accessible name from its title, moves focus inside on open, and traps
 * Tab and Shift+Tab at the edges so focus never leaves while it is open. Escape
 * dismisses it the way Observe does. The App restores focus to the reopen control
 * after the overlay unmounts.
 */
import { useEffect, useRef } from "react";
import type { IntroCopy } from "./content/narrative";

interface IntroOverlayProps {
  copy: IntroCopy;
  repoUrl: string;
  /** Dismiss only. Also the Escape handler. */
  onObserve: () => void;
  /** Dismiss, then scroll to the chaos ladder. */
  onCauseChaos: () => void;
  /** Dismiss, then scroll to the engine editor. */
  onEditEngine: () => void;
}

/** The dialog's focusable controls, in DOM order. */
function focusableControls(dialog: HTMLElement): HTMLElement[] {
  return [...dialog.querySelectorAll<HTMLElement>("button, a[href]")];
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
