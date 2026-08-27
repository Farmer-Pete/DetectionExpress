/**
 * The wire between Ingest and Sink, drawn as a chevron belt.
 *
 * The belt is an SVG pattern of chevrons that fills the whole wire and scrolls
 * toward the Sink. Its scroll speed is the edge's `outRate`, so a slow Sink slows
 * the belt and a stopped Sink freezes it. The chevron color is the downstream
 * node's heat, ramped calm -> warning -> danger through the palette tokens. Above
 * HEAT_STROBE the belt strobes in the threat color.
 *
 * A requestAnimationFrame loop reads the store snapshot directly (getState, off
 * React's render path), so the animation never re-renders the graph. Slice 0
 * keeps both nodes at one height, so the belt is horizontal and the pattern tiles
 * with no gap.
 */
import type { EdgeProps } from "@xyflow/react";
import { useEffect, useRef } from "react";
import { useGameStore } from "../../game/store";
import { HEAT_STROBE } from "../../game/tuning";

const BELT_H = 14; // belt thickness
const TILE = 14; // chevron spacing
const SCROLL = 6; // belt pixels per outRate unit per second

/** Heat mapped to a palette token: seagrass -> alert gold -> threat red. */
function heatToken(heat: number) {
  if (heat >= HEAT_STROBE) {
    return "var(--threat)";
  }
  if (heat >= 0.3) {
    return "var(--alert)";
  }
  return "var(--ok)";
}

export function StreamEdge(props: EdgeProps) {
  const width = props.targetX - props.sourceX;
  const beltTop = props.sourceY - BELT_H / 2;
  const edgeId = props.id;
  const downstreamId = props.target;

  const patternRef = useRef<SVGPatternElement | null>(null);
  const chevronRef = useRef<SVGPathElement | null>(null);
  const beltRef = useRef<SVGRectElement | null>(null);

  useEffect(() => {
    const pattern = patternRef.current;
    const chevron = chevronRef.current;
    const belt = beltRef.current;
    if (!pattern || !chevron || !belt) {
      return;
    }

    let offset = 0;
    let last = performance.now();
    let raf = 0;

    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;

      const snapshot = useGameStore.getState().snapshot;
      const outRate = snapshot.edges[edgeId]?.outRate ?? 0;
      const heat = snapshot.nodes[downstreamId]?.heat ?? 0;

      offset += outRate * SCROLL * dt;
      pattern.setAttribute("patternTransform", `translate(${offset % TILE},${beltTop})`);
      chevron.style.stroke = heatToken(heat);

      if (heat >= HEAT_STROBE) {
        const pulse = 0.5 + 0.5 * Math.sin(now / 140);
        belt.style.filter = `drop-shadow(0 0 ${3 + pulse * 7}px var(--threat))`;
        belt.style.opacity = String(0.7 + 0.3 * pulse);
      } else {
        belt.style.filter = "none";
        belt.style.opacity = "1";
      }

      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => cancelAnimationFrame(raf);
  }, [beltTop, edgeId, downstreamId]);

  return (
    <>
      <defs>
        <pattern
          ref={patternRef}
          id={`chevrons-${edgeId}`}
          width={TILE}
          height={BELT_H}
          patternUnits="userSpaceOnUse"
        >
          <path
            ref={chevronRef}
            className="stream-chevron"
            d={`M3,3 L10,${BELT_H / 2} L3,${BELT_H - 3}`}
            fill="none"
          />
        </pattern>
      </defs>
      <rect
        className="stream-belt-bg"
        x={props.sourceX}
        y={beltTop}
        width={width}
        height={BELT_H}
        rx={7}
      />
      <rect
        ref={beltRef}
        x={props.sourceX}
        y={beltTop}
        width={width}
        height={BELT_H}
        rx={7}
        fill={`url(#chevrons-${edgeId})`}
      />
    </>
  );
}
