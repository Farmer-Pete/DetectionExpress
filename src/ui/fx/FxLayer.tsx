/**
 * The FX coordinator (T12, GH37-PLAN.md). It subscribes to `snapshot.findings`,
 * `snapshot.decisions`, and `runToken`, diffs each against what it saw last render
 * with the pure helpers in `fx-events.ts`, and spawns transient overlay items: a
 * cited-row flash (through the store's fx slice, so `LogRow` can read it) plus a
 * comet for every landed finding's cited evidence, and a verdict pop for every new
 * decision. It owns every FX DOM node in its own fixed overlay and never touches a
 * React-owned row.
 *
 * Positions are measured at spawn time from `getBoundingClientRect()` on
 * `data-testid="log-row-<id>"` rows and `data-finding-seq` finding rows, intersected
 * with their panel's visible rect (`.log-stream`, `.findings-panel`), per the
 * deterministic fallback rules in GH37-PLAN.md "Off-screen and missing anchors": a
 * mounted but off-screen anchor clamps into the panel; a missing one falls back to
 * the panel's bottom edge (top edge for a miss, which never has a row to anchor on).
 *
 * FX pacing is a `requestAnimationFrame` loop plus CSS keyframes, never sim ticks or
 * `setInterval` (ARCHITECTURE rule 8): the clock here is wall time, render-side only,
 * and nothing it produces feeds back into the sim. `clock` is injectable so a test
 * can drive it by hand, the same seam `engine.ts` gives its `TickDriver`.
 */
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { type FlashSpawn, useGameStore } from "../../game/store";
import type { Decision, LiveFinding } from "../../sim/correctness";
import { diffDecisions, diffFindings } from "./fx-events";
import { createHuntPalette, type HuntPalette } from "./palette";

/** Crib timings from the prototype (GH37-PLAN.md): flash 1.2s, comet ~0.5s, pop ~1.1s. */
const FLASH_DURATION_MS = 1200;
const COMET_DURATION_MS = 520;
const POP_DURATION_MS = 1100;

/** The FX clock: real wall time by default, a manual one under test. */
export interface FxClock {
  now(): number;
  requestFrame(callback: FrameRequestCallback): number;
  cancelFrame(id: number): void;
}

const REAL_CLOCK: FxClock = {
  now: () => performance.now(),
  requestFrame: (callback) => requestAnimationFrame(callback),
  cancelFrame: (id) => cancelAnimationFrame(id),
};

export interface FxLayerProps {
  clock?: FxClock;
}

// ---- geometry: viewport-relative points and rects, measured at spawn time only ----

interface FxPoint {
  x: number;
  y: number;
}

interface FxRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function toFxRect(rect: DOMRect): FxRect {
  return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
}

function rectCenter(rect: FxRect): FxPoint {
  return { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 };
}

function intersects(a: FxRect, b: FxRect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function clampToRect(point: FxPoint, rect: FxRect): FxPoint {
  return { x: clamp(point.x, rect.left, rect.right), y: clamp(point.y, rect.top, rect.bottom) };
}

function edgeCenter(rect: FxRect, edge: "top" | "bottom"): FxPoint {
  return { x: (rect.left + rect.right) / 2, y: edge === "top" ? rect.top : rect.bottom };
}

const ORIGIN: FxPoint = { x: 0, y: 0 };

function panelRect(selector: string): FxRect | null {
  const el = document.querySelector(selector);
  return el === null ? null : toFxRect(el.getBoundingClientRect());
}

/**
 * One anchor point, deterministic in every case (GH37-PLAN.md "Off-screen and
 * missing anchors"): the element's own center when it is mounted and on screen;
 * clamped into the panel when mounted but off screen; the panel's `missingEdge`
 * center when the element does not exist at all (evicted from the ring, capped
 * behind "+N more", or gone from the live set).
 */
function resolveAnchor(
  selector: string,
  panel: FxRect | null,
  missingEdge: "top" | "bottom",
): FxPoint {
  if (panel === null) {
    return ORIGIN; // the panel itself is unmounted; degenerate, should not occur in practice
  }
  const el = document.querySelector(selector);
  if (el === null) {
    return edgeCenter(panel, missingEdge);
  }
  const rect = toFxRect(el.getBoundingClientRect());
  return intersects(rect, panel) ? rectCenter(rect) : clampToRect(rectCenter(rect), panel);
}

const LOG_PANEL_SELECTOR = ".log-stream";
const FINDINGS_PANEL_SELECTOR = ".findings-panel";
const logRowSelector = (eventId: number): string => `[data-testid="log-row-${eventId}"]`;
const findingRowSelector = (seq: number): string => `[data-finding-seq="${seq}"]`;

// ---- overlay item types ----

interface CometFx {
  id: number;
  kind: "comet";
  colorVar: string;
  from: FxPoint;
  to: FxPoint;
  createdAt: number;
}

interface PopFx {
  id: number;
  kind: "pop";
  text: string;
  colorVar: string;
  at: FxPoint;
  createdAt: number;
}

type FxOverlayItem = CometFx | PopFx;

function itemDuration(item: FxOverlayItem) {
  return item.kind === "comet" ? COMET_DURATION_MS : POP_DURATION_MS;
}

/** The verdict label, color, and anchor for one decision (never a hunt color). */
function popFor(
  decision: Decision,
  findingsPanel: FxRect | null,
): { text: string; colorVar: string; at: FxPoint } {
  if (decision.outcome === "caught") {
    return {
      text: `CAUGHT · ${decision.entity}`,
      colorVar: "var(--ok)",
      at: resolveAnchor(findingRowSelector(decision.liveSeq), findingsPanel, "bottom"),
    };
  }
  if (decision.outcome === "false") {
    return {
      text: decision.entity !== undefined ? `FALSE ALERT · ${decision.entity}` : "FALSE ALERT",
      colorVar: "var(--alert)",
      at: resolveAnchor(findingRowSelector(decision.liveSeq), findingsPanel, "bottom"),
    };
  }
  return {
    text: `MISSED · ${decision.entity}`,
    colorVar: "var(--threat)",
    at: findingsPanel === null ? ORIGIN : edgeCenter(findingsPanel, "top"),
  };
}

// ---- prefers-reduced-motion ----

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

interface ReducedMotionMedia {
  matches: boolean;
  addEventListener(type: "change", listener: () => void): void;
  removeEventListener(type: "change", listener: () => void): void;
}

function reducedMotionMedia(): ReducedMotionMedia {
  return window.matchMedia(REDUCED_MOTION_QUERY);
}

function usePrefersReducedMotion(): boolean {
  const [matches, setMatches] = useState<boolean>(() => reducedMotionMedia().matches);
  useEffect(() => {
    const media = reducedMotionMedia();
    setMatches(media.matches); // re-sync: it may have changed between the initializer and mount
    const onChange = (): void => setMatches(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);
  return matches;
}

/** One pending flash's auto-clear, armed against the FX clock rather than a sim tick. */
interface PendingFlashClear {
  eventId: number;
  gen: number;
  expiresAt: number;
}

export function FxLayer({ clock = REAL_CLOCK }: FxLayerProps = {}) {
  const findings = useGameStore((s) => s.snapshot.findings);
  const decisions = useGameStore((s) => s.snapshot.decisions);
  const runToken = useGameStore((s) => s.runToken);
  const reducedMotion = usePrefersReducedMotion();

  const [items, setItems] = useState<readonly FxOverlayItem[]>([]);

  const prevRunTokenRef = useRef(runToken);
  const prevFindingsRef = useRef<readonly LiveFinding[]>([]);
  const prevDecisionsLengthRef = useRef(0);
  const firedSeqsRef = useRef<Set<number>>(new Set());
  const paletteRef = useRef<HuntPalette>(createHuntPalette());
  // The flash gen counter is monotonic for FxLayer's whole lifetime and does NOT reset
  // on a runToken change, so a stale pre-restart timer can never clear a post-restart
  // flash (GH37-PLAN.md "Cited row flash").
  const nextGenRef = useRef(0);
  const nextItemIdRef = useRef(0);
  const pendingFlashesRef = useRef<PendingFlashClear[]>([]);

  // Diff this tick's findings and decisions against the last tick FxLayer saw, and
  // spawn FX for what landed. A runToken change resets every piece of cross-tick
  // state first, so old-run FX never survive into the new run.
  useEffect(() => {
    if (runToken !== prevRunTokenRef.current) {
      prevRunTokenRef.current = runToken;
      prevFindingsRef.current = [];
      prevDecisionsLengthRef.current = 0;
      firedSeqsRef.current = new Set();
      paletteRef.current.reset();
      pendingFlashesRef.current = [];
      setItems([]);
      useGameStore.setState({ flashes: new Map() });
    }

    // Reserve a palette slot for every reason in seq order, watches included, on its
    // first appearance this run — independent of whether anything lands this tick.
    for (const finding of findings) {
      paletteRef.current.colorFor(finding.reason);
    }

    const landed = diffFindings(prevFindingsRef.current, findings, firedSeqsRef.current);
    for (const finding of landed) {
      firedSeqsRef.current.add(finding.seq);
    }
    prevFindingsRef.current = findings;

    const newDecisions = diffDecisions(prevDecisionsLengthRef.current, decisions);
    prevDecisionsLengthRef.current = decisions.length;

    if (landed.length === 0 && newDecisions.length === 0) {
      return;
    }

    const logPanel = panelRect(LOG_PANEL_SELECTOR);
    const findingsPanel = panelRect(FINDINGS_PANEL_SELECTOR);
    const now = clock.now();
    const flashSpawns: FlashSpawn[] = [];
    const newItems: FxOverlayItem[] = [];

    for (const finding of landed) {
      const huntColor = paletteRef.current.colorFor(finding.reason);
      const to = resolveAnchor(findingRowSelector(finding.seq), findingsPanel, "bottom");
      for (const eventId of new Set(finding.eventIds)) {
        const gen = nextGenRef.current++;
        flashSpawns.push({ eventId, colorVar: huntColor, gen });
        pendingFlashesRef.current.push({ eventId, gen, expiresAt: now + FLASH_DURATION_MS });
        if (!reducedMotion) {
          const from = resolveAnchor(logRowSelector(eventId), logPanel, "bottom");
          newItems.push({
            id: nextItemIdRef.current++,
            kind: "comet",
            colorVar: huntColor,
            from,
            to,
            createdAt: now,
          });
        }
      }
    }

    for (const decision of newDecisions) {
      newItems.push({
        id: nextItemIdRef.current++,
        kind: "pop",
        createdAt: now,
        ...popFor(decision, findingsPanel),
      });
    }

    if (flashSpawns.length > 0) {
      useGameStore.getState().spawnFlashes(flashSpawns);
    }
    if (newItems.length > 0) {
      setItems((current) => [...current, ...newItems]);
    }
  }, [findings, decisions, runToken, reducedMotion, clock]);

  // The rAF loop: expires pending flashes and overlay items against the FX clock, so
  // in-flight FX finish their animation regardless of the sim's freeze state.
  useEffect(() => {
    const tick = (now: number): void => {
      const stillPending: PendingFlashClear[] = [];
      for (const pending of pendingFlashesRef.current) {
        if (now >= pending.expiresAt) {
          useGameStore.getState().clearFlash(pending.eventId, pending.gen);
        } else {
          stillPending.push(pending);
        }
      }
      pendingFlashesRef.current = stillPending;
      setItems((current) => {
        const kept = current.filter((item) => now < item.createdAt + itemDuration(item));
        return kept.length === current.length ? current : kept;
      });
      frameId = clock.requestFrame(tick);
    };
    let frameId = clock.requestFrame(tick);
    return () => {
      clock.cancelFrame(frameId);
      for (const pending of pendingFlashesRef.current) {
        useGameStore.getState().clearFlash(pending.eventId, pending.gen);
      }
      pendingFlashesRef.current = [];
    };
  }, [clock]);

  return (
    <div className="fx-layer" aria-hidden="true">
      {items.map((item) =>
        item.kind === "comet" ? (
          <CometNode key={item.id} item={item} />
        ) : (
          <PopNode key={item.id} item={item} />
        ),
      )}
    </div>
  );
}

interface CometStyle extends CSSProperties {
  "--comet-dx": string;
  "--comet-dy": string;
}

interface CometNodeProps {
  item: CometFx;
}

function CometNode({ item }: CometNodeProps) {
  const style: CometStyle = {
    left: item.from.x,
    top: item.from.y,
    color: item.colorVar,
    "--comet-dx": `${item.to.x - item.from.x}px`,
    "--comet-dy": `${item.to.y - item.from.y}px`,
  };
  return <div className="fx-comet" data-testid="fx-comet" style={style} />;
}

interface PopNodeProps {
  item: PopFx;
}

function PopNode({ item }: PopNodeProps) {
  const style: CSSProperties = { left: item.at.x, top: item.at.y, color: item.colorVar };
  return (
    <div className="fx-pop" data-testid="fx-pop" style={style}>
      {item.text}
    </div>
  );
}
