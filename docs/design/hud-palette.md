# HUD palette — Vibrant Tones

This guide sets the color system for the Detection Express HUD. It records the
chosen palette, maps every color to a role, and gives a drop-in token block.
Read it before you style any gauge, panel, or Node.

Terms come from `CONTEXT.md`: Engine, Resource, Throughput, Correctness, Cost,
Flexibility, Backlog, Event, Alert, Threat, Node, SLA.

## Decision

The HUD uses the **Vibrant Tones** palette. It is a ten-color set that runs warm
to cool: red, orange, gold, then green, teal, and blue. The deep cerulean anchors
the screen. The tuscan gold carries the text and the routine accents. The
strawberry red marks danger.

The palette is broad enough on its own. It needs no extra accent color. See
[Emphasis](#emphasis).

The full comparison that led here lives in the palette lab. It renders this HUD
in thirteen palettes side by side.

## Source palette

Ten colors. These are the only hues the HUD may use.

| Swatch name      | Hex       | Role in the HUD                           |
| ---------------- | --------- | ----------------------------------------- |
| Strawberry Red   | `#f94144` | Correctness, Threat                       |
| Atomic Tangerine | `#f3722c` | Reserve accent                            |
| Carrot Orange    | `#f8961e` | Throughput, the active Node               |
| Coral Glow       | `#f9844a` | Reserve accent                            |
| Tuscan Sun       | `#f9c74f` | Text base, Alert                          |
| Willow Green     | `#90be6d` | Reserve accent                            |
| Seagrass         | `#43aa8b` | Healthy state, spare meter accent         |
| Dark Cyan        | `#4d908e` | Reserve accent                            |
| Blue Slate       | `#577590` | Reserve accent                            |
| Cerulean         | `#277da1` | Canvas base, Cost                         |

## How the palette becomes a HUD

A palette is a flat row of colors. The HUD needs a dark canvas, readable text,
and distinct accents. We build all of them from the ten colors, using only black
and white to shift light and dark. Black and white never add a new hue. So every
color on the screen traces back to a palette swatch.

1. **Canvas and panels** come from the darkest swatch, Cerulean, shaded toward
   black by fixed amounts.
2. **Text** comes from the lightest swatch, Tuscan Sun, tinted toward white just
   far enough to read.
3. **Borders and dim text** are the text hue at lower strength.
4. **Meter accents and semantic colors** are the saturated swatches, picked by
   hue so no two sit too close together.

## Tokens

Every color is a CSS custom property. Style through the token, never a raw hex.
Values below are the resolved output for this palette.

| Token       | Value                      | Where it is used                                            |
| ----------- | -------------------------- | ----------------------------------------------------------- |
| `--bg`      | `#0f303d`                  | The screen behind everything                                |
| `--panel`   | `#154457`                  | Resource tiles, Event stream, graph card                    |
| `--panel2`  | `#1b556d`                  | Meter tracks, Event rows, Node chips                        |
| `--line`    | `rgba(251, 213, 123, 0.2)` | Hairline borders and the faint grid                         |
| `--ink`     | `#fbd57b`                  | Primary text: labels, values, timestamps                   |
| `--dim`     | `#938c60`                  | Secondary text: units, muted labels                         |
| `--a1`      | `#f8961e`                  | Throughput meter fill, the active Node, sparkline endpoint  |
| `--a2`      | `#f94144`                  | Correctness meter fill, graph line, section labels, wires  |
| `--a3`      | `#277da1`                  | Cost meter fill                                             |
| `--a4`      | `#43aa8b`                  | Spare accent (seagrass)                                     |
| `--threat`  | `#f94144`                  | Threat tags, the Backlog danger zone, threat Event rows     |
| `--alert`   | `#f9c74f`                  | Alert tags, the Backlog warning zone                        |
| `--ok`      | `#43aa8b`                  | Healthy state: the "SLA met" pill                           |

## Semantic colors

These three carry meaning. They stay fixed so a player learns them once.

| Meaning          | Token      | Color         | Reads as                          |
| ---------------- | ---------- | ------------- | --------------------------------- |
| Threat / failure | `--threat` | Strawberry red| An Event is malicious             |
| Alert / warning  | `--alert`  | Tuscan gold   | The Engine flagged an Event       |
| Healthy / met    | `--ok`     | Seagrass      | A Resource is inside its SLA      |

Semantic colors sit on outlines, stripes, tags, and small fills. They are not
the accent, and they are not body text. Body text is always `--ink`.

**Watch the Correctness bar.** The derivation lands `--a2` on strawberry red, the
same hue as `--threat`. So the Correctness meter fill and the graph line read as
the danger color. If that is confusing, override Correctness to Seagrass (`--a4`)
or Tuscan gold. Keep the change to the fill only, not to `--threat`.

## Emphasis

The key readouts do not need a special color. The palette is broad, and the gold
text already reads well on the deep canvas. So:

- The four Resource values and the ingest rate use `--ink`, bold.
- The active **Detect** Node and the newest sparkline point use `--a1`, the carrot
  orange. It is warm and stands apart from the red danger hue and the cool canvas.

An earlier draft added a complementary "pop" color for these readouts. This
palette does not need it. A pop is only worth it when a palette is narrow in hue
and the numbers would blend in. Vibrant Tones already spans the wheel, so the pop
added a color without adding contrast. We dropped it.

## Contrast

Measured against the WCAG 2.1 formula.

| Pair                       | Ratio    | Verdict                                   |
| -------------------------- | -------- | ----------------------------------------- |
| `--ink` on `--bg`          | ~9.9:1   | Passes AAA. Primary text and readouts.    |
| `--dim` on `--panel`       | ~3.1:1   | Large or secondary text only.             |

Keep `--dim` for units and muted labels at that size or larger. Do not use it for
small body text. If small muted text is needed, step up to `--ink`.

## Drop-in

Paste this into the HUD root. Style components through the tokens.

```css
:root {
  /* Detection Express HUD — Vibrant Tones */
  --bg:     #0f303d;
  --panel:  #154457;
  --panel2: #1b556d;
  --line:   rgba(251, 213, 123, 0.2);
  --ink:    #fbd57b;
  --dim:    #938c60;

  --a1: #f8961e; /* Throughput, active Node, sparkline endpoint */
  --a2: #f94144; /* Correctness, graph line, labels — shares Threat's hue */
  --a3: #277da1; /* Cost */
  --a4: #43aa8b; /* spare (seagrass) */

  --threat: #f94144;
  --alert:  #f9c74f;
  --ok:     #43aa8b;
}
```

## Rules

- Style through tokens. Never hard-code a hex in a component.
- Keep semantic colors for meaning, not decoration.
- Body text and the key readouts are `--ink`. Secondary text is `--dim`, at large
  or label size.
- Black and white may shade a token lighter or darker. They may not introduce a
  new hue.

## If the palette ever changes

The tokens above are derived, not hand-picked. To move to another palette, feed
its swatches through the same recipe:

1. Sort the swatches by lightness. The darkest becomes the canvas, shaded toward
   black. The lightest becomes the text, tinted toward white.
2. Pick the saturated swatches, spaced by hue, for the meters.
3. Map the warmest to Alert, the reddest to Threat, the coolest to healthy.
4. If the palette is narrow in hue, add one accent for the readouts: the
   complement of its dominant hue. A broad palette like this one does not need it.

The palette lab implements this recipe. Use it to preview a swap before it lands.
