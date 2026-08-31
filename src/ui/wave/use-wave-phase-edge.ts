/**
 * One-shot ownership for the wave's incoming -> active edge (GH38+40-PLAN.md,
 * "Wave indicator + flash + shake"). This is render state, not sim state, so it
 * stays out of the store: two independent call sites (App's shake, LogPanel's
 * flash) each hold their own instance, and a fired edge on one never triggers
 * the other's DOM.
 *
 * `previousPhase` lives in a ref, but it is only ever read and written inside
 * the effect below, never during render — mutating a ref during render breaks
 * under React Strict Mode's double-invoked render pass, which this app wraps
 * around (`main.tsx`). The returned token increments by exactly one on each
 * incoming -> active edge and holds steady on every other render, so a
 * consumer's `useEffect(() => { ... }, [edgeToken])` fires once per wave: skip
 * the initial `0`, since every real edge produces a token greater than that.
 */
import { useEffect, useRef, useState } from "react";
import type { WavePhase } from "../../sim/wave-state";

export function useWavePhaseEdge(phase: WavePhase): number {
  const previousPhase = useRef<WavePhase>(phase);
  const [edgeToken, setEdgeToken] = useState(0);

  useEffect(() => {
    if (previousPhase.current === "incoming" && phase === "active") {
      setEdgeToken((token) => token + 1);
    }
    previousPhase.current = phase;
  }, [phase]);

  return edgeToken;
}
