/**
 * A one-shot boolean flag: `true` for `durationMs` after `token` changes,
 * `false` otherwise. This is the shared shape behind App's `.shake` and
 * LogPanel's `.waveflash` (GH38 review round 5, F002/F003) — both fed an
 * `edgeToken` from `useWavePhaseEdge` into an identical `useState` +
 * `useEffect(token) { set true; setTimeout clear; cleanup }` block. Each
 * consumer still calls this hook itself and holds its own instance, so the
 * two call sites stay decoupled: one consumer's flag never drives another's
 * DOM, exactly as before the extraction.
 *
 * `token === 0` never raises the flag, matching `useWavePhaseEdge`'s
 * convention that `0` is the untouched initial value, not a fired edge.
 */
import { useEffect, useState } from "react";

export function useOneShotFlag(token: number, durationMs: number): boolean {
  const [active, setActive] = useState(false);

  useEffect(() => {
    if (token === 0) {
      return;
    }
    setActive(true);
    const timer = setTimeout(() => setActive(false), durationMs);
    return () => clearTimeout(timer);
  }, [token, durationMs]);

  return active;
}
