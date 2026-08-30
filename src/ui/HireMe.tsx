/**
 * The Hire Me surface: a small topbar button that toggles a compact card. The card
 * carries Peter's pitch, that this simulation is a live demo of his work, that he is
 * open to work, and his email as a mailto link.
 */
import { useEffect, useRef, useState } from "react";
import type { HireMeCopy } from "./content/narrative";

interface HireMeProps {
  copy: HireMeCopy;
}

const CARD_ID = "hire-me-card";

export function HireMe({ copy }: HireMeProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

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
    <div className="hire-me" ref={containerRef}>
      <button
        type="button"
        className="hire-me-toggle"
        aria-expanded={open}
        aria-controls={CARD_ID}
        onClick={() => setOpen((was) => !was)}
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
          <a className="hire-me-email" href={`mailto:${copy.email}`}>
            {copy.email}
          </a>
        </div>
      ) : null}
    </div>
  );
}
