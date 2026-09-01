/**
 * The Hire Me surface: a small topbar button that toggles a compact card. The card
 * carries Peter's pitch, that this simulation is a live demo of his work, that he is
 * open to work, and his email as a mailto link.
 *
 * The button draws attention on its own: a rotating gradient border plus a periodic
 * nudge (both in `src/index.css`). Opening it dims the rest of the app behind a
 * full-screen scrim and lifts the button and card above it, and fires a one-shot
 * confetti burst from the button (`celebrate`, which itself honors reduced motion).
 */
import { useEffect, useRef, useState } from "react";
import { type ConfettiOrigin, celebrate as fireConfetti, originOf } from "./confetti";
import type { HireMeCopy } from "./content/narrative";

interface HireMeProps {
  copy: HireMeCopy;
  // The confetti seam, injectable like the app's controller factories so a test can
  // pass a spy instead of running canvas-confetti. Defaults to the real burst.
  celebrate?: (origin: ConfettiOrigin) => void;
}

const CARD_ID = "hire-me-card";

export function HireMe({ copy, celebrate = fireConfetti }: HireMeProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);

  // Open the card, dim the app, and celebrate. Extracted so the toggle and any other
  // caller take the same path; closing is the plain `setOpen(false)`.
  const openCard = (): void => {
    setOpen(true);
    if (toggleRef.current !== null) {
      celebrate(originOf(toggleRef.current));
    }
  };

  // While the card is open, Escape closes it and a click outside it closes it. Both
  // listeners attach only while open, so they never intercept events otherwise. The
  // Escape handler skips an already-handled event, so dismissing the intro overlay
  // (which marks its own Escape handled) never also closes this card.
  useEffect(() => {
    if (!open) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        setOpen(false);
      }
    };
    const onClick = (event: MouseEvent): void => {
      const container = containerRef.current;
      if (container !== null && event.target instanceof Node && !container.contains(event.target)) {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    document.addEventListener("click", onClick);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("click", onClick);
    };
  }, [open]);

  return (
    <div className={open ? "hire-me open" : "hire-me"} ref={containerRef}>
      {open ? (
        // A full-screen scrim dims the rest of the app; the button and card sit above
        // it. Clicking it closes the card, the same as clicking anywhere outside.
        <button
          type="button"
          className="hire-me-scrim"
          aria-label="Dismiss"
          onClick={() => setOpen(false)}
        />
      ) : null}
      <button
        type="button"
        ref={toggleRef}
        className="hire-me-toggle"
        aria-expanded={open}
        aria-controls={CARD_ID}
        onClick={() => (open ? setOpen(false) : openCard())}
      >
        {copy.heading}
      </button>
      {open ? (
        <div id={CARD_ID} className="hire-me-card">
          {copy.body.map((paragraph) => (
            <p key={paragraph} className="hire-me-text">
              {paragraph}
            </p>
          ))}
          {/* The emoji sits outside each link so the link's accessible name stays the
              address/URL alone. LinkedIn opens in a new tab, so `rel` blocks the
              opener. */}
          <p className="hire-me-contact">
            <span aria-hidden="true">✉️</span>
            <a className="hire-me-link" href={`mailto:${copy.email}`}>
              {copy.email}
            </a>
          </p>
          <p className="hire-me-contact">
            <span aria-hidden="true">🌎</span>
            <a
              className="hire-me-link"
              href={copy.linkedin}
              target="_blank"
              rel="noopener noreferrer"
            >
              LinkedIn
            </a>
          </p>
        </div>
      ) : null}
    </div>
  );
}
