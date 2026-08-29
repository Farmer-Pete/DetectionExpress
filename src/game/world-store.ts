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
}

export const useWorldStore = create<WorldState>((set) => ({
  worldSnapshot: emptyWorldSnapshot(),
  setWorldSnapshot: (worldSnapshot) => set({ worldSnapshot }),
}));
