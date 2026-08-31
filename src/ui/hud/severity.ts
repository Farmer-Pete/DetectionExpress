/**
 * The shared severity ramp. A fraction of a max maps to one threat token: healthy
 * below `SEVERITY_WARN_FRAC`, warning from there, danger from `SEVERITY_DANGER_FRAC`.
 * The HUD gauges and the log panel's queue bar both read from here, so one
 * threshold set drives every fill. Generic names, not "queue"-specific: the ramp
 * also colors the Compute gauge (#38 GH38-PLAN.md decision 3).
 */
import { SEVERITY_DANGER_FRAC, SEVERITY_WARN_FRAC } from "../../game/tuning";

/** The three-step severity level a fraction reads as, shared by `severityFill` below. */
export type SeverityLevel = "ok" | "warn" | "danger";

export function severityLevel(fraction: number): SeverityLevel {
  if (fraction >= SEVERITY_DANGER_FRAC) {
    return "danger";
  }
  if (fraction >= SEVERITY_WARN_FRAC) {
    return "warn";
  }
  return "ok";
}

const FILL_BY_LEVEL: Record<SeverityLevel, "var(--threat)" | "var(--alert)" | "var(--ok)"> = {
  danger: "var(--threat)",
  warn: "var(--alert)",
  ok: "var(--ok)",
};

export function severityFill(fraction: number): "var(--threat)" | "var(--alert)" | "var(--ok)" {
  return FILL_BY_LEVEL[severityLevel(fraction)];
}
