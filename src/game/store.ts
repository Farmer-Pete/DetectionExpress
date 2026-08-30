/**
 * The store bridges the sim to React. It holds the player's Algorithm source, the
 * level seed, the current error, and the latest sim snapshot. Fast sim state lives
 * here, not in useState, so a snapshot update re-renders only the gauges through
 * selectors, not the whole tree.
 *
 * The Pipeline topology is no longer store state. Slice 1 locks one shape and the
 * visual editor is gone, so the wiring lives as a fixed constant in `topology.ts`;
 * `getGraph()` reads it. The player edits the Rule, not the graph.
 */
import { create } from "zustand";
import type { GraphEdge, GraphNode } from "../sim/graph";
import { referenceSource } from "../sim/scenarios/kiosk-pin-attack/reference";
import { emptySnapshot, type SimSnapshot } from "../sim/snapshot";
import type { RuleErrorInfo, Speed } from "./run-controller";
import { PIPELINE_EDGES, PIPELINE_NODES } from "./topology";
import { LEVEL_SEED } from "./tuning";

/**
 * The transport mirror. The run controller owns the authoritative transport state;
 * this slice only mirrors it so the panel can paint the buttons. It does not hold the
 * controller.
 */
interface TransportState {
  frozen: boolean;
  speed: Speed;
}

interface GameState {
  snapshot: SimSnapshot;
  /** The player's Algorithm source. The editor edits it; the run controller loads it. */
  source: string;
  /**
   * The active local-IDE override, or null in in-game-editor (source) mode. Set by the
   * dev-only algorithms client when a watched file changes; the App reads it to choose a
   * url-mode `AlgorithmSource` over the in-game `source`. Dev-only in practice, but
   * generic and harmless in the static build (always null).
   */
  localAlgorithm: { path: string; version: number } | null;
  /** The deterministic level seed for the run. */
  seed: number;
  /** The current run or Rule error, or null. The editor shows it. */
  error: RuleErrorInfo | null;
  /**
   * True while an external source drives the run (a local-IDE file, hot-reloaded by the
   * algorithms-hmr plugin), so the editor locks its textarea. Generic, not dev-specific:
   * the production build carries it too, always false and harmless.
   */
  sourceLocked: boolean;
  /**
   * True while a `run()` loads and profiles a source (the Apply dry-run, app mount, or
   * a dev hot-reload). The editor disables Apply and reads "Checking..." while it holds.
   * The run controller drives it; the editor reads it.
   */
  runPending: boolean;
  /**
   * The selected finding, keyed on its stable `seq`, or null. UI state, not sim
   * state, so it survives snapshot churn (ARCHITECTURE rule 4). T9, T12, and T13
   * read it; this slice writes it.
   */
  selection: { seq: number } | null;
  /** Mirrors the run controller's transport state so the panel can paint the buttons. */
  transport: TransportState;
  setSnapshot: (snapshot: SimSnapshot) => void;
  setAlgorithmSource: (source: string) => void;
  setLocalAlgorithm: (value: { path: string; version: number } | null) => void;
  setError: (error: RuleErrorInfo | null) => void;
  setSourceLocked: (locked: boolean) => void;
  setRunPending: (pending: boolean) => void;
  /** Select a finding by seq. Re-selecting the same seq clears the selection. */
  selectFinding: (seq: number) => void;
  /** Clear the selection. Esc and a click on the empty panel call it. */
  clearSelection: () => void;
  /** Sets the transport freeze mirror. The App reflects it into the run controller. */
  setFrozen: (frozen: boolean) => void;
  /** Sets the transport speed mirror. The App reflects it into the run controller. */
  setSpeed: (speed: Speed) => void;
}

export const useGameStore = create<GameState>((set) => ({
  snapshot: emptySnapshot(),
  source: referenceSource,
  localAlgorithm: null,
  seed: LEVEL_SEED,
  error: null,
  sourceLocked: false,
  runPending: false,
  selection: null,
  transport: { frozen: false, speed: 1 },
  // Reconcile the selection on every snapshot. `seq` is stable within one run, but a
  // run restart (Apply or reload) builds a fresh scorer, so `seq` resets from zero. So
  // keep the selection only while its seq still appears in the new snapshot's findings;
  // otherwise clear it. This also clears a selection whose finding aged out by horizon.
  setSnapshot: (snapshot) =>
    set((state) => {
      if (state.selection !== null) {
        const seq = state.selection.seq;
        const present = snapshot.findings.some((live) => live.seq === seq);
        if (!present) {
          return { snapshot, selection: null };
        }
      }
      return { snapshot };
    }),
  setAlgorithmSource: (source) => set({ source }),
  setLocalAlgorithm: (localAlgorithm) => set({ localAlgorithm }),
  setError: (error) => set({ error }),
  setSourceLocked: (locked) => set({ sourceLocked: locked }),
  setRunPending: (pending) => set({ runPending: pending }),
  selectFinding: (seq) =>
    set((state) => ({ selection: state.selection?.seq === seq ? null : { seq } })),
  clearSelection: () => set({ selection: null }),
  // Each setter keeps the sibling field, so toggling freeze never resets speed and
  // vice versa.
  setFrozen: (frozen) => set((s) => ({ transport: { ...s.transport, frozen } })),
  setSpeed: (speed) => set((s) => ({ transport: { ...s.transport, speed } })),
}));

/**
 * The fixed topology, mapped to the validator's shape for the engine. Each call
 * returns fresh arrays of fresh objects, so no consumer can mutate the shared
 * `topology.ts` constants, not the array and not an object field.
 */
export function getGraph(): { nodes: GraphNode[]; edges: GraphEdge[] } {
  return {
    nodes: PIPELINE_NODES.map((node) => ({ id: node.id, kind: node.kind })),
    edges: PIPELINE_EDGES.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
    })),
  };
}
