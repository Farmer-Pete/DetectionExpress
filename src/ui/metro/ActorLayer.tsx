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
import { metroLayout, type Point } from "../../sim/world/layout";
import { world } from "../../sim/world/world";
import type { FlashEvent, WorldSnapshot } from "../../sim/world-snapshot";
import { DESIGN_HEIGHT, DESIGN_WIDTH } from "./design";
import { presencePoint } from "./interpolate";

/** The rider dot color (`--ink`) and the flash token per firing sensor kind. */
const INK = "#fbd57b";
const FLASH_COLOR: Record<FlashEvent["kind"], string> = {
  tap: "#f2a900",
  topup: "#90be6d",
  signin: "#f9c74f",
  grant: "#43aa8b",
  deny: "#f94144",
  door: "#577590",
  command: "#f94144",
  packet: "#f8961e",
};

/** The flash ring grows from this radius to this over the flash's life (design units). */
const FLASH_RING_MIN = 4;
const FLASH_RING_MAX = 18;

/** A rider is fully opaque while moving, slightly dimmed while waiting or dwelling. */
const RIDER_MOVING_ALPHA = 1;
const RIDER_DWELL_ALPHA = 0.85;

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

      ctx.fillStyle = INK;
      for (const actor of snapshot.actors) {
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
