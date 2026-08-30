/**
 * The world store bridges the metro sim to React, a sibling to `store.ts`. It holds
 * only the latest world snapshot: an array of actor presences, not pipeline gauges.
 * A sibling store isolates the two modes and keeps each snapshot small (ARCHITECTURE
 * rule 4 wants an external store, not exactly one). The pipeline store is untouched.
 */
import { create } from "zustand";
import { emptyWorldSnapshot, type WorldSnapshot } from "../sim/world-snapshot";

interface WorldState {
  worldSnapshot: WorldSnapshot;
  setWorldSnapshot: (snapshot: WorldSnapshot) => void;
  /** The header's pause toggle. The engine freezes the sim while paused. */
  paused: boolean;
  setPaused: (paused: boolean) => void;
  /** The header's speed multiplier (0.25 to 4). The engine samples it each tick. */
  speed: number;
  setSpeed: (speed: number) => void;
}

export const useWorldStore = create<WorldState>((set) => ({
  worldSnapshot: emptyWorldSnapshot(),
  setWorldSnapshot: (worldSnapshot) => set({ worldSnapshot }),
  paused: false,
  setPaused: (paused) => set({ paused }),
  speed: 1,
  setSpeed: (speed) => set({ speed }),
}));

/** The effective sim speed the engine samples: zero while paused, else the multiplier. */
export function worldSpeed(): number {
  const state = useWorldStore.getState();
  return state.paused ? 0 : state.speed;
}
