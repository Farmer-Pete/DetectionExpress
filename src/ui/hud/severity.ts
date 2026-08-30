/**
 * The shared severity ramp. A fraction of a max maps to one threat token: healthy
 * below 0.5, warning from 0.5, danger from 0.8. The HUD gauges and the log panel's
 * queue bar both read from here, so one threshold set drives every fill.
 */
export function severityFill(fraction: number): "var(--threat)" | "var(--alert)" | "var(--ok)" {
  if (fraction >= 0.8) {
    return "var(--threat)";
  }
  if (fraction >= 0.5) {
    return "var(--alert)";
  }
  return "var(--ok)";
}
