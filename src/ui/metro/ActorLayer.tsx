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
import { presencePoint } from "./interpolate";

/** The rider dot color (`--ink`) and the flash token per firing sensor kind. */
const INK = "#fbd57b";
const TRAIN_FILL = "#cfe3ea";
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

/**
 * A stable per-rider onboard offset, so a boarded rider keeps one seat by the train
 * rather than jittering each frame. Derived from the rider id, spread over the offset
 * box; deterministic and pure.
 */
function onboardOffset(id: string): Point {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0;
  }
  const unit = (bits: number): number => ((bits >>> 0) % 1000) / 1000; // [0,1)
  return {
    x: (unit(hash) * 2 - 1) * ONBOARD_DX,
    y: (unit(hash >> 10) * 2 - 1) * ONBOARD_DY,
  };
}

/** A uniform design-space -> canvas transform: fit and center, never stretch. */
interface View {
  scale: number;
  offsetX: number;
  offsetY: number;
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

      // Index the trains so a boarded rider can ride with the train it named.
      const trainById = new Map<string, ActorView>();
      for (const actor of snapshot.actors) {
        if (actor.kind === "train") {
          trainById.set(actor.id, actor);
        }
      }

      for (const actor of snapshot.actors) {
        if (actor.kind === "train") {
          // A train rides its line's offset polyline, rotated to face its travel
          // direction, stroked in its line color.
          const color = TRAIN_COLOR_BY_ID.get(actor.id) ?? TRAIN_FILL;
          const { point, angle } = trainPlacement(actor.presence, layout, renderNow);
          drawTrain(ctx, view, point, angle, color);
          continue;
        }
        ctx.fillStyle = INK;
        if (actor.presence.kind === "onTrain") {
          // A boarded rider is placed near its train's glyph and drawn fully opaque
          // (view notes section 4). If the train is gone the rider is not drawn.
          const train = trainById.get(actor.presence.train);
          if (train === undefined) {
            continue;
          }
          const base = trainPlacement(train.presence, layout, renderNow).point;
          const offset = onboardOffset(actor.id);
          ctx.globalAlpha = RIDER_MOVING_ALPHA;
          drawRider(ctx, view, { x: base.x + offset.x, y: base.y + offset.y });
          continue;
        }
        // Dim a waiting or dwelling rider; a moving rider is fully opaque.
        ctx.globalAlpha = actor.presence.kind === "moving" ? RIDER_MOVING_ALPHA : RIDER_DWELL_ALPHA;
        drawRider(ctx, view, presencePoint(actor.presence, layout, renderNow));
      }
      ctx.globalAlpha = 1;
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
