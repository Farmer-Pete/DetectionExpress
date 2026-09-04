/**
 * The guided tour's ordered steps (GH132-PLAN.md "Tour redesign (M2 feedback): 8
 * steps, drawer-open step 2", docs/adr/0012-guided-tour.md). This array is the
 * single source of step order; `use-tour.ts` resolves each `target` to a
 * `[data-tour="<target>"]` selector and each `copyKey` to its prose in `tourCopy`
 * (`ui/content/narrative.ts`).
 *
 * Order: the map, the chaos ladder (opens the side panel in tour mode), the map
 * again (clickable stations/trains/sensors), the sensor log, findings,
 * decisions, the Hire me button, then back to the map for a closing summary.
 */
import type { TourCopy } from "../content/narrative";

/** A stable anchor. Resolves to `[data-tour="<target>"]`. The six values below are
 *  the whole set the app renders (`MetroView`, `SidePanel`, `LogPanel`,
 *  `FindingsPanel`, `DecisionsPanel`, `HireMe` — GH132-PLAN.md M2). */
export type TourTarget = "map" | "chaos" | "log" | "findings" | "decisions" | "hire";

export interface TourStep {
  /** Stable anchor. Resolves to `[data-tour="<target>"]`. */
  target: TourTarget;
  /** Which `tourCopy` entry this step shows. */
  copyKey: keyof TourCopy;
  /** Popover placement, relative to the target. */
  side: "top" | "bottom" | "left" | "right";
  /** The chaos step only: entering it opens the side panel in tour mode
   *  (`use-side-panel.tsx`'s `openForTour`), leaving it closes the panel again
   *  (`closeForTour`) before the driver moves on (GH132-PLAN.md "Step 2
   *  drawer-open: Codex fixes (accepted)", rules 4-5). */
  opensDrawer?: boolean;
}

export const tourSteps: readonly TourStep[] = [
  { target: "map", copyKey: "map", side: "bottom" },
  { target: "chaos", copyKey: "chaos", side: "left", opensDrawer: true },
  { target: "map", copyKey: "click", side: "bottom" },
  { target: "log", copyKey: "log", side: "left" },
  { target: "findings", copyKey: "findings", side: "left" },
  { target: "decisions", copyKey: "decisions", side: "top" },
  { target: "hire", copyKey: "hire", side: "left" },
  { target: "map", copyKey: "summary", side: "bottom" },
];
