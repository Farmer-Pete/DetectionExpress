# ADR 0002 — HUD palette: Vibrant Tones

- Status: Accepted
- Date: 2026-08-26

## Context

The HUD had no fixed color system. We needed one palette that reads as a
real-time security console: a dark canvas, legible text, distinct Resource
meters, and clear Threat and Alert states.

We built a palette lab that renders the same HUD in thirteen candidate palettes.
Each demo is built strictly from its own colors. The darkest swatch, shaded
toward black, becomes the canvas. The lightest, tinted toward white, becomes the
text. The saturated swatches become the meters and the semantic states. Black
and white only shift light and dark, never hue.

Some palettes are close in hue across all their swatches, so their key numbers
blend into the screen. For those, one extra accent helps: the complement of the
palette's dominant hue, spent only on the readouts. A broad palette does not need
it.

We compared the thirteen side by side and picked the one that read cleanest as a
console.

## Decision

Adopt **Vibrant Tones** as the HUD palette.

- Source swatches: `#f94144`, `#f3722c`, `#f8961e`, `#f9844a`, `#f9c74f`,
  `#90be6d`, `#43aa8b`, `#4d908e`, `#577590`, `#277da1`.
- Canvas is the deep cerulean, shaded toward black.
- Text is the tuscan gold, tinted toward white.
- Threat is strawberry red, Alert is gold, healthy is seagrass.
- No extra accent. The palette spans warm to cool, so the key readouts use the
  gold text, and the active Node uses carrot orange. A complementary pop was
  tried and dropped: it added a color without adding contrast.

The full token set, contrast numbers, usage rules, and a drop-in CSS block live
in [the HUD palette guide](../design/hud-palette.md).

## Consequences

Good:

- One documented color system for the whole HUD. Style through tokens, not hexes.
- Primary text and the key readouts clear WCAG AAA on the canvas (~9.9:1).
- Fewer colors. The HUD uses the palette and nothing else.

Costs:

- The palette is derived, so a future swap means re-running the recipe in the
  guide, not editing tokens by hand.
- The Correctness meter shares strawberry red with Threat. The guide notes an
  override if that reads as danger.
