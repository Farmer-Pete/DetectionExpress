/**
 * A one-shot confetti burst in the HUD palette, fired when the Hire Me card opens.
 * This is pure render juice: canvas-confetti paints its own full-screen canvas and
 * paces with `requestAnimationFrame`, which the architecture allows for render
 * animations (never fed back into the sim, ARCHITECTURE.md rule 8). It lives in
 * `ui/` as a thin wrapper so `HireMe` stays free of the library's option shape and
 * so a test can mock this one seam.
 */
import confetti from "canvas-confetti";

/** The burst origin, in normalized viewport coordinates (0..1), per canvas-confetti. */
export interface ConfettiOrigin {
  x: number;
  y: number;
}

/** The six HUD accents (src/index.css), so the confetti reads as the same palette. */
const HUD_COLORS = ["#f8961e", "#f94144", "#fbd57b", "#43aa8b", "#4cc9f0", "#f9c74f"];

/**
 * Fire one confetti burst from `origin`. `disableForReducedMotion` lets the library
 * itself honor `prefers-reduced-motion`, so a reduced-motion viewer gets no burst.
 */
export function celebrate(origin: ConfettiOrigin): void {
  confetti({
    particleCount: 120,
    // The button sits in the top-right corner, so the burst aims down and to the
    // left (225°) to stay on screen instead of firing up past the viewport edge.
    angle: 225,
    spread: 80,
    startVelocity: 42,
    ticks: 220,
    gravity: 0.9,
    scalar: 0.9,
    origin,
    colors: HUD_COLORS,
    disableForReducedMotion: true,
  });
}

/** The normalized viewport center of `element`, as a confetti origin. */
export function originOf(element: Element): ConfettiOrigin {
  const rect = element.getBoundingClientRect();
  return {
    x: (rect.left + rect.width / 2) / window.innerWidth,
    y: (rect.top + rect.height / 2) / window.innerHeight,
  };
}
