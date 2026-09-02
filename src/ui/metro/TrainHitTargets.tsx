/**
 * Focusable, transparent SVG hit targets for the map's trains (GH124-PLAN.md
 * Checkpoint 4). A train itself is drawn on `ActorLayer.tsx`'s passive `<canvas>`,
 * which exposes no DOM nodes a pointer or keyboard could ever land on — so each of
 * the four trains gets one transparent `<rect>` here instead, rendered as a sibling
 * inside `MetroMap.tsx`'s own SVG (design-space coordinates, the same `viewBox` that
 * auto-scales the map, so it never needs the canvas's own device-pixel `fit()` math).
 *
 * The rect's position is NOT React state: this component runs its own
 * `requestAnimationFrame` loop, reading the store outside React and imperatively
 * setting each rect's `transform`, using the exact same `trainPlacement` calculation
 * and render-clock extrapolation `ActorLayer.tsx` uses. A 20 Hz snapshot-driven React
 * re-render would visibly lag the 60 Hz canvas; this loop is what keeps the hit
 * target locked to the drawn train every frame.
 *
 * The four train ids are fixed fixtures of `world.json` (one per line), so the set of
 * rects never changes across a run; only their position does.
 */
import { useEffect, useRef } from "react";
import type { MapSelection } from "../../game/store";
import { useGameStore } from "../../game/store";
import { CLOCK_HZ } from "../../game/tuning";
import { metroLayout } from "../../sim/world/layout";
import { trainIdForLine } from "../../sim/world/timetable";
import { world } from "../../sim/world/world";
import { renderSpeed } from "./interpolate";
import { trainPlacement } from "./train-placement";

const TRAIN_IDS: readonly string[] = world.lines.map((line) => trainIdForLine(world, line.id));

/** Slightly larger than the drawn 22 x 11 train pill (`ActorLayer.tsx`), so the
 *  target is easier to hit than the glyph itself. */
const HIT_W = 28;
const HIT_H = 18;

interface TrainHitTargetsProps {
  onSelect: (selection: MapSelection) => void;
}

export function TrainHitTargets({ onSelect }: TrainHitTargetsProps) {
  const elsRef = useRef(new Map<string, SVGRectElement>());

  useEffect(() => {
    const layout = metroLayout(world);
    let raf = 0;
    let lastNowTick = Number.NaN;
    let lastWall = performance.now();

    const frame = (): void => {
      const state = useGameStore.getState();
      const snapshot = state.snapshot;
      const speed = renderSpeed(state.transport.frozen, state.transport.speed, snapshot.status);
      const wall = performance.now();
      if (snapshot.nowTick !== lastNowTick) {
        lastNowTick = snapshot.nowTick;
        lastWall = wall;
      }
      const renderNow = snapshot.nowTick + ((wall - lastWall) / 1000) * CLOCK_HZ * speed;

      for (const actor of snapshot.actors) {
        if (actor.kind !== "train") {
          continue;
        }
        const el = elsRef.current.get(actor.id);
        if (el === undefined) {
          continue;
        }
        const { point, angle } = trainPlacement(actor.presence, layout, renderNow);
        el.setAttribute(
          "transform",
          `translate(${point.x} ${point.y}) rotate(${(angle * 180) / Math.PI})`,
        );
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <>
      {TRAIN_IDS.map((id) => (
        // biome-ignore lint/a11y/useSemanticElements: an SVG <rect> has no native button element to swap to; this is the focusable hit target tracking the train's live position (see the module doc).
        <rect
          key={id}
          ref={(el) => {
            if (el === null) {
              elsRef.current.delete(id);
            } else {
              elsRef.current.set(id, el);
            }
          }}
          className="metro-train-hit"
          x={-HIT_W / 2}
          y={-HIT_H / 2}
          width={HIT_W}
          height={HIT_H}
          role="button"
          tabIndex={0}
          aria-label={`Open ${id}`}
          onClick={() => onSelect({ kind: "train", actorId: id })}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onSelect({ kind: "train", actorId: id });
            }
          }}
        />
      ))}
    </>
  );
}
