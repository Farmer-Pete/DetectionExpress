/**
 * A thin wrapper around driver.js's own `driver()` factory (docs/adr/0012-guided-tour.md),
 * narrowed to the surface `use-tour.ts` actually calls: build an instance, `drive()` it,
 * `destroy()` it. `use-tour.ts` takes this factory as an injected dependency (default the
 * real one below), so its tests supply a fake instead of loading the real library.
 *
 * The types here are a minimal, hand-shaped subset of driver.js's own `Config`/`Driver`
 * types (`driver.js/dist/driver.js.d.ts`) — only the fields `use-tour.ts` builds or reads.
 * They stay structurally compatible with driver.js's real types, so `createTourDriver`
 * below needs no cast.
 */
import { driver } from "driver.js";

/** One step's popover content: the subset `use-tour.ts` builds from `tourCopy`. Not
 *  exported beyond this file: every other module reaches it only through
 *  `TourDriveStepConfig`'s own `popover` field. */
interface TourPopoverConfig {
  title: string;
  description: string;
  side?: "top" | "right" | "bottom" | "left";
}

/** The subset of driver.js's own `PopoverDOM` (`driver.js/dist/driver.js.d.ts`)
 *  `use-tour.ts` touches (GH137-PLAN.md M3): just the footer node it appends the
 *  `.shortcut-hint` line into. Kept loose and structurally compatible with the real,
 *  wider `PopoverDOM` — same convention the rest of this file follows — so passing
 *  `onPopoverRender` straight through to `driver()` below needs no cast. */
export interface TourPopoverDom {
  footer: HTMLElement;
}

/** One step, already resolved to a `[data-tour="..."]` element selector. */
export interface TourDriveStepConfig {
  element: string;
  popover: TourPopoverConfig;
}

/** The driver.js config surface `use-tour.ts` builds. */
export interface TourDriverConfig {
  steps: TourDriveStepConfig[];
  disableActiveInteraction?: boolean;
  animate?: boolean;
  /** Fires on Done, close, Escape, and backdrop dismissal — and on a programmatic
   *  `destroy()` call, which is how an unmount's cleanup-suppressed path exercises it. */
  onDestroyed?: () => void;
  /** Overrides the Next button. When set, driver.js does NOT advance on its own — the
   *  handler owns navigation (GH132 "own the wait"): it opens the drawer, waits for the
   *  React commit, then calls `moveNext()`. Params typed loosely to stay assignable to
   *  driver.js's own wider hook signature; `use-tour.ts` reads the closure instance. */
  onNextClick?: (element?: Element, step?: unknown, options?: unknown) => void;
  /** Overrides the Previous button, symmetric to `onNextClick`. */
  onPrevClick?: (element?: Element, step?: unknown, options?: unknown) => void;
  /** Fires once per step, right after driver.js builds that step's popover DOM
   *  (GH137-PLAN.md M3). `use-tour.ts` uses it to append the `.shortcut-hint` footer
   *  line (`← → move · Esc exit`) to every step's popover. */
  onPopoverRender?: (popover: TourPopoverDom) => void;
}

/** The driver.js instance surface `use-tour.ts` calls. */
export interface TourDriverInstance {
  drive: () => void;
  destroy: () => void;
  moveNext: () => void;
  movePrevious: () => void;
  moveTo: (index: number) => void;
  getActiveIndex: () => number | undefined;
}

/** A factory from config to a running-capable instance. Tests inject a fake. */
export type TourDriverFactory = (config: TourDriverConfig) => TourDriverInstance;

/** The real factory: driver.js's own `driver()`. `use-tour.ts`'s `createDriver`
 *  parameter defaults to this, so the app gets it for free and only a test needs to
 *  pass anything else. */
export const createTourDriver: TourDriverFactory = (config) => driver(config);
