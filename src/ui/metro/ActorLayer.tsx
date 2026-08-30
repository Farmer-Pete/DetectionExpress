/**
 * The actor layer: a canvas over the static SVG map that draws the moving cast and
 * the sensor flashes. It subscribes to `useWorldStore` OUTSIDE React's render, reading
 * the latest snapshot each animation frame, so a 20 Hz publish still animates at 60 Hz
 * and React never reconciles the hot path (ARCHITECTURE rules 3-5).
 *
 * Each actor is drawn by interpolating its presence over `[fromTick, untilTick]`
 * against a fractional render estimate of `nowTick` (the estimate is UI-only and
 * never re-enters the sim). Flashes use ONE universal treatment: an expanding, fading
 * ring plus a dot, colored by the firing sensor's token. `requestAnimationFrame`
 * drives it; the effect cancels on unmount.
 */
import { useEffect, useRef } from "react";
import { CLOCK_HZ, FLASH_LIFE_TICKS } from "../../game/tuning";
import { useWorldStore } from "../../game/world-store";
import { metroLayout, metroLines, type Point } from "../../sim/world/layout";
import type { Presence } from "../../sim/world/presence";
import { trainIdForLine } from "../../sim/world/timetable";
import { world } from "../../sim/world/world";
import type { ActorView, FlashEvent, WorldSnapshot } from "../../sim/world-snapshot";
import { DESIGN_HEIGHT, DESIGN_WIDTH } from "./design";
import { presencePoint, stepBetween } from "./interpolate";

/** The rider dot color (`--ink`) and the flash token per firing sensor kind. */
const INK = "#fbd57b";
/** An account rider's dot color (`--s-kiosk`), so it reads as "at the kiosk". */
const ACCOUNT_FILL = "#f9c74f";
const TRAIN_FILL = "#cfe3ea";
/** The staff glyph: a filled 7x7 green (`--ok`) square (view notes section 4). */
const STAFF_FILL = "#43aa8b";
const STAFF_SIZE = 7;
/** An open door lights its door-contact (D) chip: a small stroked square in `--s-contact`. */
const DOOR_OPEN_COLOR = "#577590";
const DOOR_MARK_SIZE = 9;
const FLASH_COLOR: Record<FlashEvent["kind"], string> = {
  tap: "#f2a900",
  topup: "#90be6d",
  signin: "#f9c74f",
  grant: "#43aa8b",
  deny: "#f94144",
  door: "#577590",
  command: "#f94144",
  packet: "#f8961e",
  train: TRAIN_FILL,
};

/** The flash ring grows from this radius to this over the flash's life (design units). */
const FLASH_RING_MIN = 4;
const FLASH_RING_MAX = 18;

/** A rider is fully opaque while moving, slightly dimmed while waiting or dwelling. */
const RIDER_MOVING_ALPHA = 1;
const RIDER_DWELL_ALPHA = 0.85;

/** The train pill, per view notes section 4: 22 x 11 design units, stroke width 2.5. */
const TRAIN_W = 22;
const TRAIN_H = 11;
const TRAIN_STROKE = 2.5;

/**
 * A train rides ON its line's OFFSET polyline (the same path MetroMap draws), not the
 * raw straight line between station centers. Each line's polyline points are indexed by
 * position, so a presence's `rail` (a from/to point index) resolves to the exact drawn
 * segment. Indexing by point, not by (line, station), is what lets a loop distinguish
 * its repeated station (the Circle's cen appears at both ends of its polyline).
 */
const POINTS_BY_LINE = new Map<string, readonly Point[]>(
  metroLines(world).map((poly) => [poly.id, poly.points]),
);

/** Each train's line color, keyed by its id (T1..T4 = world lines in order). */
const TRAIN_COLOR_BY_ID = new Map(
  world.lines.map((line) => [trainIdForLine(world, line.id), line.color]),
);

/** A boarded rider clusters near its train glyph: dx +/-8, dy +/-6 (view notes section 4). */
const ONBOARD_DX = 8;
const ONBOARD_DY = 6;

/** A waiting/dwelling rider clusters below its platform: dx +/-14, dy +10..+24. */
const WAIT_DX = 14;
const WAIT_DY_MIN = 10;
const WAIT_DY_MAX = 24;

/** The short render windows, in render ticks, for the visible board and alight steps. */
const BOARD_TICKS = 14;
const ALIGHT_TICKS = 12;

/** A deterministic 32-bit hash of an actor id, for stable per-rider offsets. */
function idHash(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0;
  }
  return hash;
}

/** A stable `[0, 1)` unit drawn from an id hash, shifted so two axes decorrelate. */
function unitFrom(hash: number, shift: number): number {
  return (((hash >> shift) >>> 0) % 1000) / 1000;
}

/**
 * A stable per-rider onboard offset, so a boarded rider keeps one seat by the train
 * rather than jittering each frame. Derived from the rider id, spread over the offset
 * box; deterministic and pure.
 */
function onboardOffset(id: string): Point {
  const hash = idHash(id);
  return {
    x: (unitFrom(hash, 0) * 2 - 1) * ONBOARD_DX,
    y: (unitFrom(hash, 10) * 2 - 1) * ONBOARD_DY,
  };
}

/**
 * A stable per-rider platform slot: a point clustered just below the station node, so
 * a crowd of waiting riders reads as people on the platform rather than a single dot.
 * Deterministic per id, so a rider holds its spot without jitter.
 */
function platformSlot(node: Point, id: string): Point {
  const hash = idHash(id);
  return {
    x: node.x + (unitFrom(hash, 3) * 2 - 1) * WAIT_DX,
    y: node.y + WAIT_DY_MIN + unitFrom(hash, 13) * (WAIT_DY_MAX - WAIT_DY_MIN),
  };
}

/** A uniform design-space -> canvas transform: fit and center, never stretch. */
interface View {
  scale: number;
  offsetX: number;
  offsetY: number;
}

/** The short board / alight step a rider is mid-way through. */
interface RiderTransition {
  mode: "board" | "alight";
  /** The platform node: the origin for a board, the destination for an alight. */
  node: string;
  /** Where the alight step starts (the rider's last spot by the train). */
  from?: Point | undefined;
  /** The render tick the step began on. */
  start: number;
}

/** A rider's cross-frame render state, for detecting and animating on / off a train. */
interface RiderAnim {
  kind: Presence["kind"];
  /** The last station the rider stood `at`, the origin platform for a board. */
  atNode?: string | undefined;
  /** The last point the rider was drawn at, the start of an alight step. */
  lastPoint?: Point | undefined;
  transition?: RiderTransition | undefined;
}

function fit(width: number, height: number): View {
  const scale = Math.min(width / DESIGN_WIDTH, height / DESIGN_HEIGHT);
  return {
    scale,
    offsetX: (width - DESIGN_WIDTH * scale) / 2,
    offsetY: (height - DESIGN_HEIGHT * scale) / 2,
  };
}

const ORIGIN: Point = { x: 0, y: 0 };

/** The clamped `[0,1]` progress of a moving presence at `renderNow`. */
function movingFraction(fromTick: number, untilTick: number, renderNow: number): number {
  const span = untilTick - fromTick;
  const raw = span <= 0 ? 1 : (renderNow - fromTick) / span;
  return Math.max(0, Math.min(1, raw));
}

/**
 * Where a train sits and which way it faces at `renderNow`. It reads the presence's
 * `rail` metadata and rides the exact drawn polyline segment: a moving train slides from
 * the segment's near point to its far point and faces that direction; a dwelling train
 * rests on the far (arrival) point, keeping the same tangent so it does not rotate or
 * snap when it stops. Without rail metadata it falls back to the station node.
 */
function trainPlacement(
  presence: Presence,
  layout: ReadonlyMap<string, Point>,
  renderNow: number,
): { point: Point; angle: number } {
  if (presence.kind === "onTrain") {
    // A train is never itself onTrain; this only satisfies the union. Boarded riders
    // are placed relative to their train's placement by the caller, not here.
    return { point: ORIGIN, angle: 0 };
  }
  const rail = presence.rail;
  if (rail !== undefined) {
    const points = POINTS_BY_LINE.get(rail.line) ?? [];
    const a = points[rail.from] ?? ORIGIN;
    const b = points[rail.to] ?? ORIGIN;
    const t =
      presence.kind === "moving"
        ? movingFraction(presence.fromTick, presence.untilTick, renderNow)
        : 1;
    const still = a.x === b.x && a.y === b.y;
    return {
      point: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t },
      angle: still ? 0 : Math.atan2(b.y - a.y, b.x - a.x),
    };
  }
  if (presence.kind === "at") {
    return { point: layout.get(presence.node) ?? ORIGIN, angle: 0 };
  }
  const from = layout.get(presence.from) ?? ORIGIN;
  const to = layout.get(presence.to) ?? ORIGIN;
  const t = movingFraction(presence.fromTick, presence.untilTick, renderNow);
  return {
    point: { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t },
    angle: Math.atan2(to.y - from.y, to.x - from.x),
  };
}

function drawTrain(
  ctx: CanvasRenderingContext2D,
  view: View,
  point: Point,
  angle: number,
  color: string,
): void {
  const cx = view.offsetX + point.x * view.scale;
  const cy = view.offsetY + point.y * view.scale;
  const w = TRAIN_W * view.scale;
  const h = TRAIN_H * view.scale;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  ctx.beginPath();
  // A rounded rect: the pill shape from view notes section 4. `roundRect` is standard in
  // every current browser; the layer is a no-op under test (happy-dom has no 2d context).
  ctx.roundRect(-w / 2, -h / 2, w, h, h / 2);
  ctx.fillStyle = TRAIN_FILL;
  ctx.fill();
  ctx.lineWidth = TRAIN_STROKE * view.scale;
  ctx.strokeStyle = color;
  ctx.stroke();
  ctx.restore();
}

function drawRider(ctx: CanvasRenderingContext2D, view: View, point: Point): void {
  ctx.beginPath();
  ctx.arc(
    view.offsetX + point.x * view.scale,
    view.offsetY + point.y * view.scale,
    3.2 * view.scale,
    0,
    Math.PI * 2,
  );
  ctx.fill();
}

/** A staff member: a filled green square centered on its point (view notes section 4). */
function drawStaff(ctx: CanvasRenderingContext2D, view: View, point: Point): void {
  const size = STAFF_SIZE * view.scale;
  ctx.fillStyle = STAFF_FILL;
  ctx.fillRect(
    view.offsetX + point.x * view.scale - size / 2,
    view.offsetY + point.y * view.scale - size / 2,
    size,
    size,
  );
}

/** An open-door mark: a small stroked square on the door-contact chip. */
function drawDoorMark(ctx: CanvasRenderingContext2D, view: View, point: Point): void {
  const size = DOOR_MARK_SIZE * view.scale;
  ctx.strokeStyle = DOOR_OPEN_COLOR;
  ctx.lineWidth = 1.5 * view.scale;
  ctx.strokeRect(
    view.offsetX + point.x * view.scale - size / 2,
    view.offsetY + point.y * view.scale - size / 2,
    size,
    size,
  );
}

function drawFlash(
  ctx: CanvasRenderingContext2D,
  view: View,
  point: Point,
  flash: FlashEvent,
  renderNow: number,
): void {
  const age = (renderNow - flash.atTick) / FLASH_LIFE_TICKS;
  if (age < 0 || age > 1) {
    return;
  }
  const cx = view.offsetX + point.x * view.scale;
  const cy = view.offsetY + point.y * view.scale;
  const radius = (FLASH_RING_MIN + (FLASH_RING_MAX - FLASH_RING_MIN) * age) * view.scale;
  const alpha = 1 - age;
  const color = FLASH_COLOR[flash.kind];
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5 * view.scale;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(cx, cy, 2.2 * view.scale, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
}

export function ActorLayer() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) {
      return;
    }
    const ctx = canvas.getContext("2d");
    if (ctx === null) {
      return; // happy-dom (tests) has no 2d context; the layer is a no-op there.
    }
    const layout = metroLayout(world);
    let raf = 0;
    let lastNowTick = Number.NaN;
    let lastWall = performance.now();
    // Per-rider render state carried across frames, so the canvas can spot the moment
    // a rider boards (its presence flips from `at` to `onTrain`) or alights (the flip
    // back) and animate the short step on / off the train. Keyed by actor id; pruned
    // when a rider despawns. It is pure render state and never re-enters the sim.
    const riderAnim = new Map<string, RiderAnim>();

    const draw = (snapshot: WorldSnapshot, renderNow: number): void => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
      const height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      const view = fit(width, height);
      ctx.clearRect(0, 0, width, height);

      // Draw the trains first and index them, so a boarding rider can step toward the
      // exact spot its train occupies this frame.
      const trainById = new Map<string, ActorView>();
      for (const actor of snapshot.actors) {
        if (actor.kind !== "train") {
          continue;
        }
        trainById.set(actor.id, actor);
        const color = TRAIN_COLOR_BY_ID.get(actor.id) ?? TRAIN_FILL;
        const { point, angle } = trainPlacement(actor.presence, layout, renderNow);
        drawTrain(ctx, view, point, angle, color);
      }

      /** The seat point by a named train this frame, or null when the train is gone. */
      const seatOf = (trainId: string, riderId: string): Point | null => {
        const train = trainById.get(trainId);
        if (train === undefined) {
          return null;
        }
        const base = trainPlacement(train.presence, layout, renderNow).point;
        const offset = onboardOffset(riderId);
        return { x: base.x + offset.x, y: base.y + offset.y };
      };

      const liveRiderIds = new Set<string>();
      for (const actor of snapshot.actors) {
        if (actor.kind === "train") {
          continue;
        }
        if (actor.kind === "staff") {
          // A staff member is a green square, walking the site<->station line or resting
          // at the site; onTrain never applies, so presencePoint places it directly.
          ctx.globalAlpha = 1;
          drawStaff(ctx, view, presencePoint(actor.presence, layout, renderNow));
          continue;
        }

        // A rider (or account rider). Track its presence across frames to catch the
        // board / alight flip and animate the short step on / off the train.
        liveRiderIds.add(actor.id);
        const prev = riderAnim.get(actor.id);
        const presence = actor.presence;
        let transition = prev?.transition;
        if (prev?.kind === "at" && presence.kind === "onTrain") {
          transition = { mode: "board", node: prev.atNode ?? "", start: renderNow };
        } else if (prev?.kind === "onTrain" && presence.kind === "at") {
          transition = {
            mode: "alight",
            node: presence.node,
            from: prev.lastPoint,
            start: renderNow,
          };
        }
        if (transition !== undefined) {
          const span = transition.mode === "board" ? BOARD_TICKS : ALIGHT_TICKS;
          if (renderNow - transition.start >= span) {
            transition = undefined;
          }
        }

        ctx.fillStyle = actor.kind === "account-rider" ? ACCOUNT_FILL : INK;
        let point: Point | null;
        let alpha = RIDER_MOVING_ALPHA;
        if (transition?.mode === "board") {
          // Step from the origin platform onto the train's current spot.
          const originNode = layout.get(transition.node);
          const start = originNode !== undefined ? platformSlot(originNode, actor.id) : null;
          const seat = presence.kind === "onTrain" ? seatOf(presence.train, actor.id) : null;
          point =
            start !== null && seat !== null
              ? stepBetween(start, seat, transition.start, BOARD_TICKS, renderNow)
              : (seat ?? start);
        } else if (transition?.mode === "alight") {
          // Step off the train onto the destination platform, then dwell there.
          const destNode = layout.get(transition.node);
          const end = destNode !== undefined ? platformSlot(destNode, actor.id) : null;
          const from = transition.from ?? end;
          point =
            end !== null && from !== null
              ? stepBetween(from, end, transition.start, ALIGHT_TICKS, renderNow)
              : end;
          alpha = RIDER_DWELL_ALPHA;
        } else if (presence.kind === "onTrain") {
          point = seatOf(presence.train, actor.id);
        } else if (presence.kind === "at") {
          // Cluster the waiting or dwelling rider on its platform.
          const node = layout.get(presence.node);
          point = node !== undefined ? platformSlot(node, actor.id) : null;
          alpha = RIDER_DWELL_ALPHA;
        } else {
          // A rider moving along a line edge (the no-timetable fallback).
          point = presencePoint(presence, layout, renderNow);
        }

        if (point !== null) {
          ctx.globalAlpha = alpha;
          drawRider(ctx, view, point);
        }
        riderAnim.set(actor.id, {
          kind: presence.kind,
          atNode: presence.kind === "at" ? presence.node : prev?.atNode,
          lastPoint: point ?? prev?.lastPoint,
          transition,
        });
      }
      // Prune render state for riders that have despawned, so the map stays bounded.
      for (const id of [...riderAnim.keys()]) {
        if (!liveRiderIds.has(id)) {
          riderAnim.delete(id);
        }
      }

      ctx.globalAlpha = 1;
      // An open door: mark its door-contact chip so the door state reads on the map.
      for (const door of snapshot.doors) {
        if (!door.open) {
          continue;
        }
        const point = layout.get(door.node);
        if (point !== undefined) {
          drawDoorMark(ctx, view, point);
        }
      }
      for (const flash of snapshot.flashes) {
        const point = layout.get(flash.node);
        if (point !== undefined) {
          drawFlash(ctx, view, point, flash, renderNow);
        }
      }
    };

    const frame = (): void => {
      const state = useWorldStore.getState();
      const snapshot = state.worldSnapshot;
      const speed = state.paused ? 0 : state.speed;
      const wall = performance.now();
      if (snapshot.nowTick !== lastNowTick) {
        lastNowTick = snapshot.nowTick;
        lastWall = wall;
      }
      // The fractional render estimate: extrapolate from the published tick at the
      // sim's rate. UI-only; it never enters the sim.
      const renderNow = snapshot.nowTick + ((wall - lastWall) / 1000) * CLOCK_HZ * speed;
      draw(snapshot, renderNow);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => cancelAnimationFrame(raf);
  }, []);

  return <canvas ref={canvasRef} className="metro-actors" />;
}
