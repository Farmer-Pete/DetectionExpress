/**
 * The actor layer: a canvas over the static SVG map that draws the moving cast and
 * the sensor flashes. It subscribes to `useGameStore` OUTSIDE React's render, reading
 * the latest snapshot each animation frame, so a 20 Hz publish still animates at 60 Hz
 * and React never reconciles the hot path (ARCHITECTURE rules 3-5).
 *
 * Each actor is drawn by interpolating its presence over `[fromTick, untilTick]`
 * against a fractional render estimate of `nowTick` (the estimate is UI-only and
 * never re-enters the sim). Flashes use ONE universal treatment: an expanding, fading
 * ring plus a dot, colored by the firing sensor's token. `requestAnimationFrame`
 * drives it; the effect cancels on unmount.
 *
 * GH117 Part F: the merged engine publishes both the scored run and the map onto one
 * `SimSnapshot` in `useGameStore`, so this layer reads that store now, not the
 * retired `useWorldStore`. The render-estimate speed comes from the one pipeline
 * transport (`snapshot` state's `transport.frozen`/`transport.speed`), not a metro-only
 * pause/speed pair — and drops to zero once `snapshot.status` leaves `"running"`, so
 * the map holds its last frame under the terminal overlay instead of sliding on
 * (`renderSpeed`, `interpolate.ts`).
 */
import { useEffect, useRef } from "react";
import { useGameStore } from "../../game/store";
import { CLOCK_HZ, FLASH_LIFE_TICKS } from "../../game/tuning";
import type { SimSnapshot } from "../../sim/snapshot";
import { metroLayout, type Point } from "../../sim/world/layout";
import type { Presence } from "../../sim/world/presence";
import { trainIdForLine } from "../../sim/world/timetable";
import { world } from "../../sim/world/world";
import type { ActorView, FlashEvent } from "../../sim/world-snapshot";
import { DESIGN_HEIGHT, DESIGN_WIDTH } from "./design";
import { presencePoint, renderSpeed, stepBetween } from "./interpolate";
import { trainPlacement } from "./train-placement";

/** The rider dot color (`--ink`) and the flash token per firing sensor kind. */
const INK = "#fbd57b";
/** An account rider's dot color (`--s-kiosk`), so it reads as "at the kiosk". */
const ACCOUNT_FILL = "#f9c74f";
const TRAIN_FILL = "#cfe3ea";
/**
 * The pin attacker's distinguishing ring (GH117 decision 4): a red-ringed dot, so the
 * player can spot the attacker on the map before the detector ever raises a finding.
 * Shares its hue with the `pinfail` flash below, so an attacker and the wrong-PIN
 * fumbles it causes read as one family.
 */
const ATTACKER_RING = "#f94144";
const ATTACKER_RING_RADIUS = 5.5;
/** The staff glyph: a filled 7x7 green (`--ok`) square (view notes section 4). */
const STAFF_FILL = "#43aa8b";
const STAFF_SIZE = 7;
/** An open door lights its door-contact (D) chip: a small stroked square in `--s-contact`. */
const DOOR_OPEN_COLOR = "#577590";
const DOOR_MARK_SIZE = 9;
/** A network-relay pulse travels the site -> OCC backdrop link, in `--s-relay`. */
const RELAY_COLOR = "#f8961e";
/** The OCC node a network pulse travels toward (the site -> OCC control backbone). */
const OCC_ID = world.controlCenter.id;
/** A crowd-density disc on the camera (C) chip, in `--s-cam`, sized by the window count. */
const CROWD_COLOR = "#4cc9f0";
/** The disc radius grows from this to this (design units) as the window count saturates. */
const CROWD_R_MIN = 2.5;
const CROWD_R_MAX = 8;
/** The window grant count at which the density disc is fully grown and opaque. */
const CROWD_SATURATION = 16;
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
  // A wrong-PIN kiosk fail (GH117 decision 4), benign or attack: every fumble flashes,
  // whichever actor caused it, so the player can see it before the detector scores it.
  pinfail: ATTACKER_RING,
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
// At 4x speed the publish stride is 12 sim ticks, and the 15-tick dwell exposes only
// ~12 stationary render ticks; 11 fits fully at 1x and 2x (see GH116-PLAN.md, "Board
// animation length"). A perfectly completed board frame at 4x is a deliberate,
// documented trade-off, not guaranteed.
const BOARD_TICKS = 11;
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

/**
 * A pin attacker: the rider dot plus a red ring around it (GH117 decision 4), so it
 * reads distinctly from a benign rider or account rider at a glance.
 */
function drawPinAttacker(ctx: CanvasRenderingContext2D, view: View, point: Point): void {
  drawRider(ctx, view, point);
  const cx = view.offsetX + point.x * view.scale;
  const cy = view.offsetY + point.y * view.scale;
  ctx.beginPath();
  ctx.arc(cx, cy, ATTACKER_RING_RADIUS * view.scale, 0, Math.PI * 2);
  ctx.strokeStyle = ATTACKER_RING;
  ctx.lineWidth = 1.5 * view.scale;
  ctx.stroke();
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

/**
 * A crowd-density mark: a filled disc on a station's camera (C) chip whose radius and
 * opacity grow with the tap count the camera counted over its window, so a busy gate
 * reads as a denser mark that decays as the taps age out. This is a real density
 * indicator, NOT the prototype's 1-for-1 gate-tap echo (view notes section 6).
 */
function drawCrowd(ctx: CanvasRenderingContext2D, view: View, point: Point, grants: number): void {
  const fill = Math.min(1, grants / CROWD_SATURATION);
  const radius = (CROWD_R_MIN + (CROWD_R_MAX - CROWD_R_MIN) * fill) * view.scale;
  ctx.globalAlpha = 0.3 + 0.5 * fill;
  ctx.fillStyle = CROWD_COLOR;
  ctx.beginPath();
  ctx.arc(
    view.offsetX + point.x * view.scale,
    view.offsetY + point.y * view.scale,
    radius,
    0,
    Math.PI * 2,
  );
  ctx.fill();
  ctx.globalAlpha = 1;
}

/**
 * A network pulse: the faint dashed site -> OCC backdrop link brightens and a bright dot
 * travels along it from the firing site toward the OCC, so the ambient control network
 * reads as LIVE when a relay fires. Driven by a packet flash's age over its life, so the
 * pulse fades with the flash. This makes the existing backdrop live rather than adding a
 * new structure (view notes section 2 + 6).
 */
function drawNetworkPulse(
  ctx: CanvasRenderingContext2D,
  view: View,
  from: Point,
  to: Point,
  age: number,
): void {
  const ax = view.offsetX + from.x * view.scale;
  const ay = view.offsetY + from.y * view.scale;
  const bx = view.offsetX + to.x * view.scale;
  const by = view.offsetY + to.y * view.scale;
  const fade = 1 - age;
  // Brighten the whole link, strongest as the packet leaves, fading as it lands.
  ctx.globalAlpha = 0.25 * fade;
  ctx.strokeStyle = RELAY_COLOR;
  ctx.lineWidth = 1.5 * view.scale;
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.lineTo(bx, by);
  ctx.stroke();
  // The travelling packet dot: from the site toward the OCC over the flash's life.
  ctx.globalAlpha = fade;
  ctx.fillStyle = RELAY_COLOR;
  ctx.beginPath();
  ctx.arc(ax + (bx - ax) * age, ay + (by - ay) * age, 2.6 * view.scale, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
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

    const draw = (snapshot: SimSnapshot, renderNow: number): void => {
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
        if (actor.kind === "operator" || actor.kind === "host") {
          // A control-room fixture: it sits at a chip the whole run and is represented by
          // its command / relay flash (and, for a host, the network pulse), not a moving
          // glyph. Drawing it as a rider dot on the OCC or a site would misread.
          continue;
        }

        // A rider (or account rider). In steady mode the engine pre-seeds every future
        // patron `at` its station at tick 0, so skip one whose window has not opened yet
        // (fromTick > now): draw only actors present now, matching `actorsAtNode`.
        if (actor.presence.kind === "at" && actor.presence.fromTick > renderNow) {
          continue;
        }
        // Track its presence across frames to catch the board / alight flip and animate
        // the short step on / off the train.
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
          if (actor.kind === "pin-attacker") {
            drawPinAttacker(ctx, view, point);
          } else {
            drawRider(ctx, view, point);
          }
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
      // The crowd density per gate: a disc on each active station's camera (C) chip,
      // sized by the window's tap count. Drawn under the doors and flashes.
      for (const crowd of snapshot.crowds) {
        const point = layout.get(crowd.node);
        if (point !== undefined) {
          drawCrowd(ctx, view, point, crowd.grants);
        }
      }
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
      // The live control network: each packet flash pulses the site -> OCC backdrop link.
      // A packet flash lands on a site's relay (N) chip, so the pulse runs from that site
      // node to the OCC. Drawn under the flash rings so the ring reads on top.
      const occPoint = layout.get(OCC_ID);
      if (occPoint !== undefined) {
        for (const flash of snapshot.flashes) {
          if (flash.kind !== "packet") {
            continue;
          }
          const site = flash.node.split(":")[0] ?? "";
          if (site === "" || site === OCC_ID) {
            continue;
          }
          const from = layout.get(site);
          if (from === undefined) {
            continue;
          }
          const age = (renderNow - flash.atTick) / FLASH_LIFE_TICKS;
          if (age < 0 || age > 1) {
            continue;
          }
          drawNetworkPulse(ctx, view, from, occPoint, age);
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
      const state = useGameStore.getState();
      const snapshot = state.snapshot;
      // Zero once the run concludes (not just while frozen), so the map holds its last
      // frame under the "simulation ended" overlay instead of sliding actors on toward
      // positions the sim never reached.
      const speed = renderSpeed(state.transport.frozen, state.transport.speed, snapshot.status);
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
