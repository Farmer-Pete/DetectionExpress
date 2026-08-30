/**
 * The Hire Me surface: a small topbar button that toggles a compact card. The card
 * carries Peter's pitch, that this simulation is a live demo of his work, that he is
 * open to work, and his email as a mailto link.
 */
import { useState } from "react";
import type { HireMeCopy } from "./content/narrative";

interface HireMeProps {
  copy: HireMeCopy;
}

export function HireMe({ copy }: HireMeProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="hire-me">
      <button
        type="button"
        className="hire-me-toggle"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
      >
        {copy.heading}
      </button>
      {open ? (
        <div className="hire-me-card">
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
