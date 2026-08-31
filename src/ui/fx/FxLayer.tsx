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
import { diffDecisions, diffFindings, unfiredLandingDecisions } from "./fx-events";
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

function viewportRect(): FxRect {
  return { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
}

function intersectRect(a: FxRect, b: FxRect): FxRect | null {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.right, b.right);
  const bottom = Math.min(a.bottom, b.bottom);
  return left < right && top < bottom ? { left, top, right, bottom } : null;
}

/**
 * A rect outside the viewport, collapsed to a zero-height line at the nearest
 * viewport edge, holding the rect's horizontal span (itself clamped into the
 * viewport). There is no visible interior left for an anchor to land inside — only
 * an edge to land on.
 */
function nearestViewportEdge(rect: FxRect, viewport: FxRect): FxRect {
  const left = clamp(rect.left, viewport.left, viewport.right);
  const right = clamp(rect.right, viewport.left, viewport.right);
  const y = rect.bottom <= viewport.top ? viewport.top : viewport.bottom;
  return { left, top: y, right, bottom: y };
}

/**
 * F018: the page scrolls (the shell grows with content), so a panel's raw rect can
 * sit entirely outside the viewport, and the fixed FX overlay clips anything
 * positioned there invisible. Intersect the panel with the viewport before it is used
 * for visibility checks or fallback-edge points; a panel with no overlap at all
 * collapses to the nearest viewport edge within its horizontal span, so every
 * fallback point still lands on screen.
 */
function panelRect(selector: string): FxRect | null {
  const el = document.querySelector(selector);
  if (el === null) {
    return null;
  }
  const raw = toFxRect(el.getBoundingClientRect());
  const viewport = viewportRect();
  return intersectRect(raw, viewport) ?? nearestViewportEdge(raw, viewport);
}

/**
 * One anchor point, deterministic in every case (GH37-PLAN.md "Off-screen and
 * missing anchors"): the element's own center, clamped into the panel, when it is
 * mounted; the panel's `missingEdge` center when the element does not exist at all
 * (evicted from the ring, capped behind "+N more", or gone from the live set).
 * `clampToRect` is a no-op for a center already inside the panel, so this covers the
 * on-screen case too without a separate intersects check: proven behavior-identical
 * for every on-screen case, and no test asserts the unclamped point.
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
  return clampToRect(rectCenter(rect), panel);
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

/**
 * F009: several same-tick pops sharing one anchor (the missed case — every miss
 * anchors to the findings panel's top edge) would otherwise stack exactly on top of
 * one another and render illegibly. `stackIndex` is this pop's position among others
 * at the SAME anchor this tick, so the first pop at an anchor is untouched and each
 * later one steps diagonally away from it. Deterministic and index-based only — no
 * `Math.random` (ARCHITECTURE forbids it here) and no spawn-time delay (a pop's
 * expiry is `createdAt + duration` and its CSS animation starts on mount, so a delay
 * would need plumbing this fix does not add). Positional spread only.
 *
 * `stackIndex` wraps over a small ring: a large same-tick burst at one anchor (e.g.
 * many misses landing in the same tick) would otherwise step diagonally without
 * bound and walk later pops off the viewport. Wrapping re-stacks past the ring size
 * rather than growing the offset forever, trading exact stacking order for staying
 * on screen.
 */
const STACK_RING_SIZE = 6;

function stackedPopOffset(stackIndex: number): FxPoint {
  const ring = stackIndex % STACK_RING_SIZE;
  return { x: ring * 24, y: ring * -20 };
}

/**
 * The screen-reader announcement for one decision (F007): plain words, not the pop's
 * symbol-and-dot label, since PopNode's text is inside the `aria-hidden` overlay and
 * is otherwise the only per-entity verdict surface.
 */
function announcementFor(decision: Decision): string {
  if (decision.outcome === "caught") {
    return `Caught: ${decision.entity}`;
  }
  if (decision.outcome === "false") {
    return decision.entity !== undefined ? `False alert: ${decision.entity}` : "False alert";
  }
  return `Missed: ${decision.entity}`;
}

/**
 * F007: the single announcement for a tick that lands more decisions than
 * `ANNOUNCEMENT_CAP` can hold. A per-decision entry per landed decision would mean
 * some verdicts are never read regardless of which end of the batch the cap keeps, so
 * the burst collapses to one line naming every outcome's count instead, e.g.
 * "7 decisions: 2 caught, 5 missed".
 */
function burstSummaryFor(decisions: readonly Decision[]): string {
  let caught = 0;
  let falseAlert = 0;
  let missed = 0;
  for (const decision of decisions) {
    if (decision.outcome === "caught") {
      caught++;
    } else if (decision.outcome === "false") {
      falseAlert++;
    } else {
      missed++;
    }
  }
  const parts: string[] = [];
  if (caught > 0) {
    parts.push(`${caught} caught`);
  }
  if (falseAlert > 0) {
    parts.push(`${falseAlert} false alert${falseAlert === 1 ? "" : "s"}`);
  }
  if (missed > 0) {
    parts.push(`${missed} missed`);
  }
  return `${decisions.length} decisions: ${parts.join(", ")}`;
}

/** How many announcements the live region keeps. Older ones age out; a screen reader
 *  only needs the recent handful, not the full run history. */
const ANNOUNCEMENT_CAP = 5;

interface Announcement {
  id: number;
  text: string;
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
  const [announcements, setAnnouncements] = useState<readonly Announcement[]>([]);

  const prevRunTokenRef = useRef(runToken);
  // Seed from what the store already holds at mount, not empty: a remount (a view
  // round-trip, React Strict Mode, or any future mount over a populated store) must
  // not replay FX for findings and decisions that landed before FxLayer existed
  // (F004). Seeding empty here is exactly the bug: the store keeps the prior run's
  // snapshot while this ref starts fresh, so the first tick sees every existing hit as
  // a brand-new landing.
  const prevFindingsRef = useRef<readonly LiveFinding[]>(findings);
  const prevDecisionsLengthRef = useRef(decisions.length);
  // Seeded ONLY from findings already at "hit" at mount — NEVER from a "watch": diffFindings
  // suppresses on `firedSeqs.has(seq)` regardless of state, so seeding a watch's seq here
  // would silently swallow its later watch-to-hit promotion.
  const firedSeqsRef = useRef<Set<number>>(
    new Set(findings.filter((finding) => finding.state === "hit").map((finding) => finding.seq)),
  );
  const paletteRef = useRef<HuntPalette>(createHuntPalette());
  // The flash gen counter is monotonic for FxLayer's whole lifetime and does NOT reset
  // on a runToken change, so a stale pre-restart timer can never clear a post-restart
  // flash (GH37-PLAN.md "Cited row flash").
  const nextGenRef = useRef(0);
  const nextItemIdRef = useRef(0);
  const nextAnnouncementIdRef = useRef(0);
  const pendingFlashesRef = useRef<PendingFlashClear[]>([]);
  // The rAF loop's own view of the live overlay items, kept in lockstep with the
  // `items` state so the loop (F011) can decide, without waiting on a render, whether
  // there is still work to animate.
  const itemsRef = useRef<readonly FxOverlayItem[]>([]);
  // Set once the tick effect below mounts; the spawn effect calls it to wake a parked
  // loop. A no-op before mount and after unmount.
  const wakeLoopRef = useRef<() => void>(() => {});

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
      itemsRef.current = [];
      setItems([]);
      setAnnouncements([]);
      useGameStore.getState().clearFlashes();
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

    /**
     * The shared per-landing spawn: one cited-row flash, plus (unless reduced motion)
     * one comet per distinct cited event id, for the finding whose live row's `seq`
     * this is. The findings loop below and the F012 fallback after it both call this,
     * so the "a finding landed" -> flashes-and-comets logic exists exactly once.
     */
    const spawnLanding = (seq: number, reason: string, eventIds: readonly number[]): void => {
      const huntColor = paletteRef.current.colorFor(reason);
      const to = resolveAnchor(findingRowSelector(seq), findingsPanel, "bottom");
      for (const eventId of new Set(eventIds)) {
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
    };

    for (const finding of landed) {
      spawnLanding(finding.seq, finding.reason, finding.eventIds);
    }

    // F012: a decision whose crediting hit never appeared in a sampled findings array
    // still landed durably in the decision log. A fast rule can record the hit and
    // consume the end-of-stream marker inside the same tick's microtask phase, so
    // `finalize()` clears the live set before any snapshot samples it — the finding
    // never shows up in `landed` above, but the decision that credited it is right
    // here, carrying its own copy of the finding. Replay the same landing FX from
    // that copy, then mark the seq fired so it cannot double-fire later.
    for (const decision of unfiredLandingDecisions(newDecisions, firedSeqsRef.current)) {
      spawnLanding(
        decision.liveSeq,
        decision.finding.alert.reason,
        decision.finding.alert.eventIds,
      );
      firedSeqsRef.current.add(decision.liveSeq);
    }

    // F009: track how many pops this tick have already landed on each anchor point,
    // so a same-tick batch of misses (every miss shares the findings panel's top
    // edge) staggers instead of stacking exactly on top of itself.
    const popsPerAnchor = new Map<string, number>();
    for (const decision of newDecisions) {
      const pop = popFor(decision, findingsPanel);
      const anchorKey = `${pop.at.x},${pop.at.y}`;
      const stackIndex = popsPerAnchor.get(anchorKey) ?? 0;
      popsPerAnchor.set(anchorKey, stackIndex + 1);
      const offset = stackedPopOffset(stackIndex);
      newItems.push({
        id: nextItemIdRef.current++,
        kind: "pop",
        createdAt: now,
        text: pop.text,
        colorVar: pop.colorVar,
        at: { x: pop.at.x + offset.x, y: pop.at.y + offset.y },
      });
    }

    if (flashSpawns.length > 0) {
      useGameStore.getState().spawnFlashes(flashSpawns);
    }
    if (newItems.length > 0) {
      const next = [...itemsRef.current, ...newItems];
      itemsRef.current = next;
      setItems(next);
    }
    if (newDecisions.length > 0) {
      // F007: a plain-word announcement per decision, appended in order, into the
      // aria-live region — independent of `reducedMotion`, so it fires under it too.
      // A single tick that lands more decisions than the region can hold collapses to
      // ONE summary entry instead: a per-decision list would silently drop verdicts
      // from assistive tech no matter how the cap is sliced (whichever tail survives,
      // the rest were never announced), so the burst gets one combined line naming
      // every outcome instead.
      const newAnnouncements: Announcement[] =
        newDecisions.length > ANNOUNCEMENT_CAP
          ? [{ id: nextAnnouncementIdRef.current++, text: burstSummaryFor(newDecisions) }]
          : newDecisions.map(
              (decision): Announcement => ({
                id: nextAnnouncementIdRef.current++,
                text: announcementFor(decision),
              }),
            );
      // Plain concat-and-slice covers every reachable batch size, with no separate
      // over-cap case: an over-cap burst is already collapsed to one summary line
      // above, well under the cap, so it only ever needs appending. The remaining
      // edge case, a batch that fills the cap exactly, still comes out right without
      // help — appending a full cap's worth and slicing to the newest ANNOUNCEMENT_CAP
      // naturally displaces every prior entry, the same result the old "at or over
      // the cap" special case existed to force.
      setAnnouncements((current) => [...current, ...newAnnouncements].slice(-ANNOUNCEMENT_CAP));
    }
    if (flashSpawns.length > 0 || newItems.length > 0) {
      wakeLoopRef.current(); // F011: a spawn wakes a parked loop
    }
  }, [findings, decisions, runToken, reducedMotion, clock]);

  // The rAF loop: expires pending flashes and overlay items against the FX clock, so
  // in-flight FX finish their animation regardless of the sim's freeze state. It parks
  // itself (stops requesting frames) once nothing is pending, rather than rescheduling
  // for the component's whole lifetime (F011); the spawn effect above wakes it back up
  // through `wakeLoopRef` the moment there is work again.
  useEffect(() => {
    let frameId: number | null = null;

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

      const kept = itemsRef.current.filter((item) => now < item.createdAt + itemDuration(item));
      if (kept.length !== itemsRef.current.length) {
        itemsRef.current = kept;
        setItems(kept);
      }

      frameId = stillPending.length > 0 || kept.length > 0 ? clock.requestFrame(tick) : null;
    };

    const wake = (): void => {
      if (frameId === null) {
        frameId = clock.requestFrame(tick);
      }
    };
    wakeLoopRef.current = wake;

    return () => {
      wakeLoopRef.current = () => {};
      if (frameId !== null) {
        clock.cancelFrame(frameId);
      }
      for (const pending of pendingFlashesRef.current) {
        useGameStore.getState().clearFlash(pending.eventId, pending.gen);
      }
      pendingFlashesRef.current = [];
    };
  }, [clock]);

  // F016: when reduced motion flips ON, drop in-flight comets at once rather than
  // waiting for the rAF loop to expire them naturally. Pops are unaffected — they
  // finish; comets are the flight-path offenders reduced motion exists to remove.
  useEffect(() => {
    if (!reducedMotion) {
      return;
    }
    const withoutComets = itemsRef.current.filter((item) => item.kind !== "comet");
    if (withoutComets.length !== itemsRef.current.length) {
      itemsRef.current = withoutComets;
      setItems(withoutComets);
    }
  }, [reducedMotion]);

  return (
    <>
      <div className="fx-layer" aria-hidden="true">
        {items.map((item) =>
          item.kind === "comet" ? (
            <CometNode key={item.id} item={item} />
          ) : (
            <PopNode key={item.id} item={item} />
          ),
        )}
      </div>
      {/* F007: the only per-entity verdict surface for screen readers. Sighted players
          get PopNode's text, but that lives inside the aria-hidden overlay above, so
          this plain-word region is the sole announcement path — kept outside that
          subtree and never itself aria-hidden. */}
      <div className="visually-hidden" aria-live="polite" data-testid="fx-announcements">
        {announcements.map((announcement) => (
          <div key={announcement.id}>{announcement.text}</div>
        ))}
      </div>
    </>
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
