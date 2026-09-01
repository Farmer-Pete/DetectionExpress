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
import { emptySnapshot, type SimSnapshot } from "../sim/snapshot";
import { referenceSource } from "./engine-source";
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

/**
 * One cited log row's flash, keyed by the row's `eventId` (GH37-PLAN.md "Comets").
 * `gen` is a monotonic spawn counter FxLayer owns: a re-spawn on the same row carries
 * a higher gen, so `LogRow` remounts the flash instead of extending the old one, and
 * a stale timer (armed for an older gen) can tell it no longer owns the row.
 */
export interface FlashEntry {
  colorVar: string;
  gen: number;
}

/** One row to flash, as FxLayer spawns it. */
export interface FlashSpawn {
  eventId: number;
  colorVar: string;
  gen: number;
}

interface GameState {
  snapshot: SimSnapshot;
  /** The player's Algorithm source. The editor edits it; the run controller loads it. */
  source: string;
  /** The deterministic level seed for the run. */
  seed: number;
  /** The current run or Rule error, or null. The editor shows it. */
  error: RuleErrorInfo | null;
  /**
   * True while any overlay (the side panel, the intro, the trace dialog) is open.
   * Published by `App`'s `modalOpen` derivation. The `LogPanel` Space shortcut reads
   * it to bail while an overlay owns the run, since its window listener ignores the
   * inert shell.
   */
  overlayOpen: boolean;
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
  /**
   * The selected decision (T10), keyed on its stable `seq`, or null. Mutually
   * exclusive with `selection`: the trace dialog is single, so selecting either
   * kind clears the other. UI state, not sim state, so it survives snapshot churn.
   */
  decisionSelection: { seq: number } | null;
  /** Mirrors the run controller's transport state so the panel can paint the buttons. */
  transport: TransportState;
  /** Cited log rows currently flashing in their hunt color, keyed by `eventId`. */
  flashes: Map<number, FlashEntry>;
  /**
   * A counter FxLayer watches to detect a restart (Apply or reload) and reset its own
   * state, since the scorer's `seq` and decision log both reset to zero on a fresh
   * engine. Monotonic and argless: the run controller's own `generation` is per-
   * controller and a rebuilt controller (a fresh Metro-to-Pipeline mount) restarts it
   * from 0, so writing that value here could reissue a token FxLayer already saw and
   * skip the reset it exists to trigger.
   */
  runToken: number;
  setSnapshot: (snapshot: SimSnapshot) => void;
  setAlgorithmSource: (source: string) => void;
  setError: (error: RuleErrorInfo | null) => void;
  /** Sets the overlay-open flag. */
  setOverlayOpen: (open: boolean) => void;
  setRunPending: (pending: boolean) => void;
  /**
   * Select a finding by seq. Re-selecting the same seq clears the selection.
   * Clears any decision selection: the two are mutually exclusive. A selection is
   * stored only for a seq present in the current snapshot; a stale seq (a click that
   * raced a reconciliation, or a seq from a stale render) is ignored without
   * disturbing any open selection (GH105-PLAN.md).
   */
  selectFinding: (seq: number) => void;
  /**
   * Select a decision by seq. Re-selecting the same seq clears the selection.
   * Clears any finding selection: the two are mutually exclusive. A selection is
   * stored only for a seq present in the current snapshot; a stale seq is ignored
   * without disturbing any open selection (GH105-PLAN.md).
   */
  selectDecision: (seq: number) => void;
  /** Clear both selections. Esc and a click on the empty panel call it. */
  clearSelection: () => void;
  /** Sets the transport freeze mirror. The App reflects it into the run controller. */
  setFrozen: (frozen: boolean) => void;
  /** Sets the transport speed mirror. The App reflects it into the run controller. */
  setSpeed: (speed: Speed) => void;
  /** Spawn one batch of cited-row flashes, merging into a fresh Map. */
  spawnFlashes: (entries: readonly FlashSpawn[]) => void;
  /**
   * Clear one row's flash, but only if `gen` still matches its current entry. A
   * stale timer (armed for an older gen) is a no-op, so it can never clip a newer
   * flash spawned on the same row after it fired.
   */
  clearFlash: (eventId: number, gen: number) => void;
  /** Clear every flash at once. Called on a run-token reset, so old-run flashes
   *  never survive into the new run. */
  clearFlashes: () => void;
  /** Bump the run token by one. Called on every fresh engine install. */
  bumpRunToken: () => void;
}

export const useGameStore = create<GameState>((set) => ({
  snapshot: emptySnapshot(),
  source: referenceSource,
  seed: LEVEL_SEED,
  error: null,
  overlayOpen: false,
  runPending: false,
  selection: null,
  decisionSelection: null,
  transport: { frozen: false, speed: 1 },
  flashes: new Map(),
  runToken: 0,
  // Reconcile both selections on every snapshot, independently. `seq` is stable
  // within one run, but a run restart (Apply or reload) builds a fresh scorer, so
  // `seq` resets from zero. So keep a selection only while its seq still appears in
  // the new snapshot's findings (or decisions); otherwise clear it. This also clears
  // a finding selection that aged out by horizon, or a decision selection the cap
  // dropped.
  setSnapshot: (snapshot) =>
    set((state) => {
      const next: Partial<GameState> = { snapshot };
      if (state.selection !== null) {
        const seq = state.selection.seq;
        const present = snapshot.findings.some((live) => live.seq === seq);
        if (!present) {
          next.selection = null;
        }
      }
      if (state.decisionSelection !== null) {
        const seq = state.decisionSelection.seq;
        const present = snapshot.decisions.some((decision) => decision.seq === seq);
        if (!present) {
          next.decisionSelection = null;
        }
      }
      return next;
    }),
  setAlgorithmSource: (source) => set({ source }),
  setError: (error) => set({ error }),
  setOverlayOpen: (open) => set({ overlayOpen: open }),
  setRunPending: (pending) => set({ runPending: pending }),
  // The dialog is single, so selecting either kind always clears the other. A
  // selection is stored only for a seq present in the current snapshot, so
  // `selection !== null` always implies a live finding to render (GH105-PLAN.md):
  // (1) re-select of the same seq toggles off first; (2) validate the seq against
  // the snapshot; (3) only for a valid seq, set the selection and clear the
  // opposite one. A stale seq returns `state` itself, not `{}` — a genuine Zustand
  // no-op that leaves any open dialog untouched and publishes no new root state.
  selectFinding: (seq) =>
    set((state) => {
      if (state.selection?.seq === seq) {
        return { selection: null, decisionSelection: null }; // re-select toggles off
      }
      if (!state.snapshot.findings.some((live) => live.seq === seq)) {
        return state; // stale seq: genuine no-op, leaves any open dialog untouched
      }
      return { selection: { seq }, decisionSelection: null };
    }),
  selectDecision: (seq) =>
    set((state) => {
      if (state.decisionSelection?.seq === seq) {
        return { selection: null, decisionSelection: null };
      }
      if (!state.snapshot.decisions.some((decision) => decision.seq === seq)) {
        return state;
      }
      return { decisionSelection: { seq }, selection: null };
    }),
  clearSelection: () => set({ selection: null, decisionSelection: null }),
  // Each setter keeps the sibling field, so toggling freeze never resets speed and
  // vice versa.
  setFrozen: (frozen) => set((s) => ({ transport: { ...s.transport, frozen } })),
  setSpeed: (speed) => set((s) => ({ transport: { ...s.transport, speed } })),
  // Always a NEW Map: zustand's default equality is per-field reference, so a
  // mutated-in-place Map would never notify a `flashes` selector.
  spawnFlashes: (entries) =>
    set((state) => {
      const next = new Map(state.flashes);
      for (const entry of entries) {
        next.set(entry.eventId, { colorVar: entry.colorVar, gen: entry.gen });
      }
      return { flashes: next };
    }),
  clearFlash: (eventId, gen) =>
    set((state) => {
      const current = state.flashes.get(eventId);
      if (current === undefined || current.gen !== gen) {
        return { flashes: state.flashes }; // stale or already gone: no-op
      }
      const next = new Map(state.flashes);
      next.delete(eventId);
      return { flashes: next };
    }),
  clearFlashes: () => set({ flashes: new Map() }),
  bumpRunToken: () => set((s) => ({ runToken: s.runToken + 1 })),
}));

declare global {
  interface Window {
    /** Dev-only store handle, set just below. Absent in the production build. */
    __store?: typeof useGameStore;
  }
}

// Dev-only console handle for the store. It strips out of the production build,
// where `import.meta.env.DEV` inlines to `false`. Use it to debug state churn from
// the browser console. `__store.getState()` reads a snapshot. `__store.subscribe`
// logs each change. Wrap a setter to stack-trace who calls it. This is a debugging
// aid, never a code path: nothing in the app reads `window.__store`.
if (import.meta.env.DEV) {
  window.__store = useGameStore;
}

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
