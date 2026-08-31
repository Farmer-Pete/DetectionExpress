/**
 * The intro overlay: a first-load modal that introduces the simulation. It shows
 * the premise, two action buttons, and two links. Each action is wired by the App;
 * this component only renders and manages focus.
 *
 * It is a real modal dialog. It carries `role="dialog"` and `aria-modal="true"`,
 * takes its accessible name from its title, and moves focus inside on open. It wraps
 * Tab and Shift+Tab at the edges to keep focus within the dialog. Escape dismisses
 * it, and so does a gesture that both starts and ends outside the dialog (a gesture
 * STARTING inside never does, even if it ends outside — `src/ui/focus.ts`'s
 * `installOutsidePointerDismiss`), the way Observe does. The App restores focus to
 * the reopen control after the overlay unmounts.
 */
import { useEffect, useRef } from "react";
import type { IntroCopy } from "../content/narrative";
import { focusableControls, installOutsidePointerDismiss, trapTab } from "../focus";

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

  // A gesture outside the dialog, on the backdrop scrim, dismisses the way Observe
  // does — but only a gesture that STARTS outside; one that starts inside never does.
  // The listeners live on the document, not on the scrim element, so the scrim stays
  // a plain presentational div. See `installOutsidePointerDismiss`.
  useEffect(() => {
    return installOutsidePointerDismiss(dialogRef, onObserve);
  }, [onObserve]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      onObserve();
      return;
    }
    const dialog = dialogRef.current;
    if (dialog === null) {
      return;
    }
    // Wrap Tab/Shift+Tab at the dialog's edges (shared with TraceOverlay's own
    // trap, `src/ui/focus.ts`). `!inControls`, one of trapTab's wrap conditions,
    // is a no-op here in practice: open-focus always lands on `controls[0]`.
    trapTab(dialog, event);
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
