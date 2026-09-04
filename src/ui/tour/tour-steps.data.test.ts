/**
 * A static guard (GH132-PLAN.md Test seams #5): every step's `target` must be one of
 * the `data-tour` values the app actually renders. `RENDERED_DATA_TOUR_VALUES` below is
 * an independent list, hand-kept in sync with `MetroView.tsx`, `sidepanel/SidePanel.tsx`,
 * `log/LogPanel.tsx`, `findings/FindingsPanel.tsx`, `decisions/DecisionsPanel.tsx`, and
 * `HireMe.tsx` (GH132-PLAN.md M2, the 8-step tour) — not derived from `TourTarget` — so a
 * typo in either place still fails this test.
 */
import { describe, expect, it } from "vitest";
import { type TourTarget, tourSteps } from "./tour-steps.data";

const RENDERED_DATA_TOUR_VALUES: readonly TourTarget[] = [
  "map",
  "chaos",
  "log",
  "findings",
  "decisions",
  "hire",
];

describe("tourSteps", () => {
  it("holds exactly 8 steps (GH132-PLAN.md M2 redesign)", () => {
    expect(tourSteps).toHaveLength(8);
  });

  it("targets only data-tour anchors the app renders", () => {
    for (const step of tourSteps) {
      expect(RENDERED_DATA_TOUR_VALUES).toContain(step.target);
    }
  });

  it("starts on the map and ends back on the map (a closing summary)", () => {
    expect(tourSteps[0]?.target).toBe("map");
    expect(tourSteps.at(-1)?.target).toBe("map");
  });

  it("the second step, cause chaos, targets the chaos ladder and opens the drawer", () => {
    expect(tourSteps[1]?.target).toBe("chaos");
    expect(tourSteps[1]?.opensDrawer).toBe(true);
  });

  it("only the chaos step opens the drawer", () => {
    const opening = tourSteps.filter((step) => step.opensDrawer === true);
    expect(opening).toHaveLength(1);
    expect(opening[0]?.target).toBe("chaos");
  });

  it("the third step returns to the map, for the clickable-map explanation", () => {
    expect(tourSteps[2]?.target).toBe("map");
    expect(tourSteps[2]?.copyKey).not.toBe(tourSteps[0]?.copyKey);
  });

  it("steps 4-6 cover the log, findings, and decisions panels, in that order", () => {
    expect(tourSteps[3]?.target).toBe("log");
    expect(tourSteps[4]?.target).toBe("findings");
    expect(tourSteps[5]?.target).toBe("decisions");
  });

  it("the seventh step is the Hire me button", () => {
    expect(tourSteps[6]?.target).toBe("hire");
  });

  it("every step's copyKey is unique, so no two steps share one popover's prose", () => {
    const keys = tourSteps.map((step) => step.copyKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
