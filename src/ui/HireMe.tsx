/**
 * The Hire Me surface: a small topbar button that toggles a compact card. The card
 * carries Peter's pitch, that this simulation is a live demo of his work, that he is
 * open to work, and his email as a mailto link.
 *
 * The button draws attention on its own: a rotating gradient border plus a periodic
 * nudge (both in `src/index.css`). Opening it dims the rest of the app behind a
 * full-screen scrim and lifts the button and card above it, and fires a one-shot
 * confetti burst from the button (`celebrate`, which itself honors reduced motion).
 *
 * The toggle carries `data-tour="hire"` (GH132-PLAN.md M2, the 8-step tour's step 7):
 * the one tour anchor `App.tsx` never has to reach into a deeper child for, since
 * `Topbar` mounts this component directly.
 *
 * GH137-PLAN.md M2: `open` is now a controlled prop (`onOpenChange` reports every
 * change back) instead of a private `useState` — lifted into `App` so
 * `resolveActiveScope` (`use-shortcuts.tsx`) can see it and give it its own `"hireMe"`
 * scope, instead of shell shortcuts staying live underneath its scrim. This component
 * still owns the open-card Escape/outside-click listeners and the confetti call; it
 * just reports the resulting open/close through `onOpenChange` rather than setting its
 * own state. It also carries its own two `useShortcut` registrations: the shell
 * scope's "H" (opens while closed) and the hireMe scope's own "H" (closes while open),
 * plus the hireMe scope's badge-only "Escape" (already handled by the listener below;
 * this only renders the Dismiss scrim's badge).
 */
import { useEffect, useRef } from "react";
import { type ConfettiOrigin, celebrate as fireConfetti, originOf } from "./confetti";
import type { HireMeCopy } from "./content/narrative";
import { Kbd } from "./shortcuts/Kbd";
import { ariaKeyshortcut } from "./shortcuts/shortcuts.data";
import { useShortcut } from "./shortcuts/use-shortcut";

interface HireMeProps {
  copy: HireMeCopy;
  /** Whether the card is open. Owned by `App` (GH137-PLAN.md M2). */
  open: boolean;
  /** Reports every open/close this component would otherwise have set itself: the
   *  toggle click, Escape, and an outside click. */
  onOpenChange: (open: boolean) => void;
  // The confetti seam, injectable like the app's controller factories so a test can
  // pass a spy instead of running canvas-confetti. Defaults to the real burst.
  celebrate?: ((origin: ConfettiOrigin) => void) | undefined;
}

const CARD_ID = "hire-me-card";

export function HireMe({ copy, open, onOpenChange, celebrate = fireConfetti }: HireMeProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);

  // Open the card, dim the app, and celebrate. Extracted so the toggle and any other
  // caller take the same path; closing is the plain `onOpenChange(false)`.
  const openCard = (): void => {
    onOpenChange(true);
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
        onOpenChange(false);
      }
    };
    const onClick = (event: MouseEvent): void => {
      const container = containerRef.current;
      if (container !== null && event.target instanceof Node && !container.contains(event.target)) {
        onOpenChange(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    document.addEventListener("click", onClick);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("click", onClick);
    };
  }, [open, onOpenChange]);

  // GH137-PLAN.md M2: the shell scope's opener, live only while the card is closed —
  // the same physical "H" the hireMe scope's closer (just below) answers to while
  // open, but the two never collide: `resolveActiveScope` never reports both scopes
  // active at once, and `enabled` here mirrors the toggle's own closed/open state.
  const { key: openKey } = useShortcut({
    scope: "shell",
    id: "hire-me-open",
    onActivate: openCard,
    enabled: !open,
  });
  const { key: closeKey } = useShortcut({
    scope: "hireMe",
    id: "hire-me-close",
    onActivate: () => onOpenChange(false),
    enabled: open,
  });
  // Badge-only: the key already has an owner (the Escape listener above).
  const { key: dismissKey } = useShortcut({
    scope: "hireMe",
    id: "dismiss",
    onActivate: () => {},
    enabled: open,
  });
  const toggleKey = open ? closeKey : openKey;

  return (
    <div className={open ? "hire-me open" : "hire-me"} ref={containerRef}>
      {open ? (
        // A full-screen scrim dims the rest of the app; the button and card sit above
        // it. Clicking it closes the card, the same as clicking anywhere outside.
        <button
          type="button"
          className="hire-me-scrim"
          aria-label="Dismiss"
          aria-keyshortcuts={dismissKey === undefined ? undefined : ariaKeyshortcut(dismissKey)}
          onClick={() => onOpenChange(false)}
        >
          {dismissKey !== undefined ? <Kbd shortcutKey={dismissKey} /> : null}
        </button>
      ) : null}
      <button
        type="button"
        ref={toggleRef}
        className="hire-me-toggle"
        aria-expanded={open}
        aria-controls={CARD_ID}
        aria-keyshortcuts={toggleKey === undefined ? undefined : ariaKeyshortcut(toggleKey)}
        data-tour="hire"
        onClick={() => (open ? onOpenChange(false) : openCard())}
      >
        {copy.heading}
        {toggleKey !== undefined ? <Kbd shortcutKey={toggleKey} /> : null}
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
