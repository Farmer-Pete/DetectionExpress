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
import type { MapNodeId } from "../sim/world/presence";
import { referenceSource } from "./engine-source";
import type { RuleErrorInfo, Speed } from "./run-controller";
import { PIPELINE_EDGES, PIPELINE_NODES } from "./topology";
import { LEVEL_SEED } from "./tuning";

/**
 * What the map's place dialog (GH124-PLAN.md Checkpoint 4) is open on: a station,
 * site, or the OCC (`node`, keyed by its `MapNodeId`), or a train (`train`, keyed by
 * its actor id, e.g. `"T1"`, a separate namespace from `MapNodeId`). Defined here,
 * not in a `src/ui` module, so this game-layer store never depends on the UI layer
 * (the existing `selection`/`decisionSelection` fields follow the same rule: their
 * shape is inline, not imported from `src/ui/findings`).
 */
export type MapSelection = { kind: "node"; id: MapNodeId } | { kind: "train"; actorId: string };

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
  /**
   * The map's place-dialog selection (GH124-PLAN.md Checkpoint 4): a clicked station,
   * site, the OCC, or a train, or null while the dialog is closed. UI state, not sim
   * state (survives snapshot churn). Unlike `selection`/`decisionSelection`, it needs
   * no snapshot reconciliation: every node and train it can name is a fixed fixture of
   * `world.json`, never evicted, so a stale id can never occur. Mutually exclusive
   * with `selection`/`decisionSelection` and `eventSelection`: at most one of the
   * three store-tracked dialogs (trace, place, event) is ever open. Every opener
   * (`selectMapNode`, `selectMapTrain`, `selectFinding`, `selectDecision`,
   * `selectWorldEvent`, `openPlaceFromEvent`) clears all three sibling fields on
   * BOTH its open branch and its toggle-off/no-op branch, via the shared
   * `NO_MODAL_SELECTION` object below, rather than relying solely on the shell's
   * `inert` gate to keep a stray click from opening a second dialog. The side panel is
   * a fourth modal, held as local React state outside this store; it stays exclusive
   * with these three through `useSidePanel`'s own check plus App's opener guards, not
   * through this store (`use-side-panel.tsx`).
   */
  mapSelection: MapSelection | null;
  /**
   * The log panel's event-dialog selection (GH124-PLAN.md Checkpoint 5): the id of a
   * `WorldLogEvent` in the live ring, or null while the dialog is closed. UI state, not
   * sim state, so it survives snapshot churn on its own, but — unlike `mapSelection`,
   * which names a fixed `world.json` fixture that can never age out — the ring it names
   * an id in is bounded and evicts, so `setSnapshot` below reconciles it every publish
   * exactly like `selection`/`decisionSelection`, and `selectWorldEvent` validates a
   * fresh id against that same live set before storing it. Mutually exclusive with
   * `mapSelection` and `selection`/`decisionSelection`: see `mapSelection` above for
   * how the openers cross-clear, and for how the side panel fits in as the fourth
   * modal.
   */
  eventSelection: number | null;
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
   * Select a finding by seq. Re-selecting the same seq closes it AND clears any
   * other open dialog (decision, map, event), the same as opening it fresh — so at
   * most one dialog is ever open on every branch, not just the open one. A selection
   * is stored only for a seq present in the current snapshot; a stale seq (a click
   * that raced a reconciliation, or a seq from a stale render) is ignored without
   * disturbing any open selection (GH105-PLAN.md).
   */
  selectFinding: (seq: number) => void;
  /**
   * Select a decision by seq. Re-selecting the same seq closes it AND clears any
   * other open dialog (finding, map, event), the same as opening it fresh — so at
   * most one dialog is ever open on every branch, not just the open one. A selection
   * is stored only for a seq present in the current snapshot; a stale seq is ignored
   * without disturbing any open selection (GH105-PLAN.md).
   */
  selectDecision: (seq: number) => void;
  /** Clear both selections. Esc and a click on the empty panel call it. */
  clearSelection: () => void;
  /**
   * Select a map node (a station, site, or the OCC) by id (GH124-PLAN.md Checkpoint
   * 4). Re-selecting the same id closes it AND clears any other open dialog (event,
   * trace), the same as opening it fresh, mirroring `selectFinding` — so at most one
   * dialog is ever open on every branch.
   */
  selectMapNode: (id: MapNodeId) => void;
  /**
   * Select a train by its actor id. Re-selecting the same id closes it AND clears any
   * other open dialog (event, trace), the same as opening it fresh, mirroring
   * `selectMapNode`.
   */
  selectMapTrain: (actorId: string) => void;
  /** Clear the map selection. Esc, the backdrop, and the close button call it. */
  clearMapSelection: () => void;
  /**
   * Select a world-log event by id (GH124-PLAN.md Checkpoint 5). Re-selecting the
   * same id closes it AND clears any other open dialog (place, trace), the same as
   * opening it fresh, mirroring `selectFinding`/`selectMapNode`. An id is stored only
   * for an event present in the current snapshot's `worldEvents` ring; a stale id (a
   * click that raced a reconciliation, or an id from a stale render) is ignored
   * without disturbing any open dialog, mirroring `selectFinding`/`selectDecision`.
   */
  selectWorldEvent: (id: number) => void;
  /** Clear the event selection. Esc, the backdrop, and the close button call it. */
  clearEventSelection: () => void;
  /**
   * The event dialog's "open place" link: close the event selection and open the
   * place dialog on `placeId`, clearing any open trace selection too, in ONE atomic
   * update, so no render ever shows more than one modal open.
   */
  openPlaceFromEvent: (placeId: MapNodeId) => void;
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

/**
 * The four modal-selection fields, all cleared: the shape every opener spreads to
 * heal the "at most one modal open" invariant, on both its open branch (own field
 * overridden after the spread) and its toggle-off/no-op branch (returned as-is). One
 * constant instead of four fields hand-written in five openers means a fifth modal
 * selection, whenever one is added, only needs adding here to stay covered
 * everywhere, rather than drifting the way the toggle-off branches did before this
 * fix (Codex review).
 */
const NO_MODAL_SELECTION = {
  selection: null,
  decisionSelection: null,
  mapSelection: null,
  eventSelection: null,
} as const;

export const useGameStore = create<GameState>((set) => ({
  snapshot: emptySnapshot(),
  source: referenceSource,
  seed: LEVEL_SEED,
  error: null,
  overlayOpen: false,
  runPending: false,
  selection: null,
  decisionSelection: null,
  mapSelection: null,
  eventSelection: null,
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
      // Unlike `mapSelection` (a fixed world.json fixture, never evicted), the event
      // selection names an id in the bounded world-event ring, so it needs the same
      // per-publish reconciliation as `selection`/`decisionSelection`: close the event
      // dialog the moment its entry ages out of the ring.
      if (state.eventSelection !== null) {
        const present = snapshot.worldEvents.some((event) => event.id === state.eventSelection);
        if (!present) {
          next.eventSelection = null;
        }
      }
      return next;
    }),
  setAlgorithmSource: (source) => set({ source }),
  setError: (error) => set({ error }),
  setOverlayOpen: (open) => set({ overlayOpen: open }),
  setRunPending: (pending) => set({ runPending: pending }),
  // The trace dialog is single, so selecting either kind always clears the other,
  // and at most one of the three store-tracked dialogs (trace, map, event) is ever
  // open, so this also clears mapSelection/eventSelection — on the toggle-off branch
  // too, via NO_MODAL_SELECTION, not just the open branch. A selection is stored only
  // for a seq present in the current snapshot, so `selection !== null` always implies
  // a live finding to render (GH105-PLAN.md): (1) re-select of the same seq toggles
  // off AND heals the other three fields; (2) validate the seq against the snapshot;
  // (3) only for a valid seq, set the selection and clear the other three fields. A
  // stale seq returns `state` itself, not `{}` — a genuine Zustand no-op that leaves
  // any open dialog untouched and publishes no new root state.
  selectFinding: (seq) =>
    set((state) => {
      if (state.selection?.seq === seq) {
        return NO_MODAL_SELECTION; // re-select toggles off, and heals any stray modal
      }
      if (!state.snapshot.findings.some((live) => live.seq === seq)) {
        return state; // stale seq: genuine no-op, leaves any open dialog untouched
      }
      return { ...NO_MODAL_SELECTION, selection: { seq } };
    }),
  selectDecision: (seq) =>
    set((state) => {
      if (state.decisionSelection?.seq === seq) {
        return NO_MODAL_SELECTION; // re-select toggles off, and heals any stray modal
      }
      if (!state.snapshot.decisions.some((decision) => decision.seq === seq)) {
        return state;
      }
      return { ...NO_MODAL_SELECTION, decisionSelection: { seq } };
    }),
  clearSelection: () => set({ selection: null, decisionSelection: null }),
  // No snapshot-presence validation, unlike selectFinding/selectDecision: every node
  // and train id these can name is a fixed world.json fixture, never evicted. Still
  // clears the other two dialogs' fields on both branches (open and toggle-off), the
  // same cross-clear selectFinding and selectDecision do, so at most one dialog is
  // ever open.
  selectMapNode: (id) =>
    set((state) => {
      if (state.mapSelection?.kind === "node" && state.mapSelection.id === id) {
        return NO_MODAL_SELECTION; // re-select toggles off, and heals any stray modal
      }
      return { ...NO_MODAL_SELECTION, mapSelection: { kind: "node", id } };
    }),
  selectMapTrain: (actorId) =>
    set((state) => {
      if (state.mapSelection?.kind === "train" && state.mapSelection.actorId === actorId) {
        return NO_MODAL_SELECTION; // re-select toggles off, and heals any stray modal
      }
      return { ...NO_MODAL_SELECTION, mapSelection: { kind: "train", actorId } };
    }),
  clearMapSelection: () => set({ mapSelection: null }),
  // Validates the id against the live ring, mirroring `selectFinding`/`selectDecision`:
  // an id absent from `state.snapshot.worldEvents` is stale (its row already aged out,
  // or the dialog is frozen past a publish that evicted it) and is ignored rather than
  // stored, so the shell can never go inert with no dialog to show for it.
  selectWorldEvent: (id) =>
    set((state) => {
      if (state.eventSelection === id) {
        return NO_MODAL_SELECTION; // re-select toggles off, and heals any stray modal
      }
      if (!state.snapshot.worldEvents.some((event) => event.id === id)) {
        return state; // stale id: genuine no-op, leaves any open dialog untouched
      }
      return { ...NO_MODAL_SELECTION, eventSelection: id };
    }),
  clearEventSelection: () => set({ eventSelection: null }),
  openPlaceFromEvent: (placeId) =>
    set({ ...NO_MODAL_SELECTION, mapSelection: { kind: "node", id: placeId } }),
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
