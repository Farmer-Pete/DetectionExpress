/**
 * The Hire Me surface: a small topbar button that toggles a compact card. The card
 * carries Peter's pitch, that this simulation is a live demo of his work, that he is
 * open to work, and his email as a mailto link.
 */
import { useEffect, useState } from "react";
import type { HireMeCopy } from "./content/narrative";

interface HireMeProps {
  copy: HireMeCopy;
}

const CARD_ID = "hire-me-card";

export function HireMe({ copy }: HireMeProps) {
  const [open, setOpen] = useState(false);

  // Escape closes the card while it is open, from anywhere on the page. The listener
  // is only attached while open, so it never intercepts Escape otherwise.
  useEffect(() => {
    if (!open) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  return (
    <div className="hire-me">
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
