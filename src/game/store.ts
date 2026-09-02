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
 * One entry in the map/event dialog stack: a place (a station, site, the OCC, or a
 * train) or a world-log event, keyed the same way `MapSelection`/the old
 * `eventSelection` were. The TOP of the stack (its last entry) is the dialog on
 * screen; everything below it is dialog history a "Back" pop returns to. Replaces the
 * two independent single-selection fields (`mapSelection`/`eventSelection`) GH124
 * Checkpoints 4-5 introduced: those let EventDialog's "Open place" link and
 * PlaceDialog's scoped-log row only SWAP one dialog for the other, with no way back.
 * A bounded stack (capped at `MAX_MAP_DIALOG_DEPTH` entries — see the two "inside"
 * pushers below — a realistic session never nests anywhere near that deep) gives both
 * a real "Back", not just a bigger single slot.
 */
export type MapModalEntry =
  | { kind: "place"; selection: MapSelection }
  | { kind: "event"; id: number };

/**
 * The top of a map/event dialog stack, i.e. the entry on screen, or null while the
 * stack is empty. `PlaceDialog`/`EventDialog` both derive their own `open` from this
 * (checking `top?.kind`), so "what's showing" is computed the same way in both places
 * instead of drifting.
 */
export function topMapDialogEntry(stack: readonly MapModalEntry[]): MapModalEntry | null {
  return stack.at(-1) ?? null;
}

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
   * The map/event dialog stack (GH124 Checkpoints 4-5, restructured for Back
   * navigation): PlaceDialog and EventDialog together track ONE bounded stack (capped
   * at `MAX_MAP_DIALOG_DEPTH` entries) instead of two independent selections, so
   * opening one from inside the other PUSHES instead of swapping, and a "Back"
   * control can pop back to what was open before.
   * The TOP entry (`topMapDialogEntry(mapDialogStack)`) is the dialog on screen; an
   * empty stack means neither dialog is open. A `"place"` entry needs no snapshot
   * reconciliation (every node/train it can name is a fixed `world.json` fixture,
   * never evicted); an `"event"` entry names an id in the bounded world-event ring, so
   * `setSnapshot` below filters out any entry whose id has aged out of that ring,
   * wherever it sits in the stack, mirroring how `selection`/`decisionSelection` were
   * already reconciled — and `selectWorldEvent`/`openEventFromPlace` both validate a
   * fresh id against that same live set before pushing it.
   *
   * Mutually exclusive with `selection`/`decisionSelection`: at most one of the two
   * store-tracked dialog KINDS (trace, or this stack) is ever open. The three
   * "outside" openers (`selectMapNode`, `selectMapTrain`, `selectWorldEvent`) and the
   * two trace openers (`selectFinding`, `selectDecision`) all clear the sibling kind
   * on their open branch, via the shared `NO_MODAL_SELECTION` object below, rather
   * than relying solely on the shell's `inert` gate to keep a stray click from opening
   * a second dialog kind. Those three "outside" openers are reachable only while the
   * stack is already empty (App's guards block them otherwise, and the shell is inert
   * behind any open dialog), so each one plainly RESETS the stack to one entry rather
   * than needing its own toggle-off case. The two "inside" pushers
   * (`openPlaceFromEvent`, `openEventFromPlace`) only ever run from within an already-
   * open dialog, so they push onto whatever stack is already there instead of
   * resetting it. The side panel is a fourth modal, held as local React state outside
   * this store; it stays exclusive with these two through `useSidePanel`'s own check
   * plus App's opener guards, not through this store (`use-side-panel.tsx`).
   */
  mapDialogStack: MapModalEntry[];
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
   * Select a map node (a station, site, or the OCC) by id: an "outside" opener (a map
   * click), reachable only while the stack is already empty (App's guards enforce
   * this). RESETS `mapDialogStack` to one fresh `"place"` entry and clears any open
   * trace selection, mirroring `selectFinding`.
   */
  selectMapNode: (id: MapNodeId) => void;
  /**
   * Select a train by its actor id: an "outside" opener, mirroring `selectMapNode`.
   * RESETS `mapDialogStack` to one fresh `"place"` entry and clears any open trace
   * selection.
   */
  selectMapTrain: (actorId: string) => void;
  /**
   * Select a world-log event by id: an "outside" opener (a main-log-panel row click),
   * mirroring `selectMapNode`. RESETS `mapDialogStack` to one fresh `"event"` entry and
   * clears any open trace selection. An entry is pushed only for an id present in the
   * current snapshot's `worldEvents` ring; a stale id (a click that raced a
   * reconciliation, or an id from a stale render) is ignored without disturbing the
   * stack, mirroring `selectFinding`/`selectDecision`.
   */
  selectWorldEvent: (id: number) => void;
  /**
   * The event dialog's "Open place" link: an "inside" pusher, reachable only from
   * within an already-open event dialog. PUSHES a `"place"` entry naming `placeId` on
   * top of whatever is already in `mapDialogStack`, so the event dialog it was clicked
   * from stays in the stack for a later "Back" to return to, instead of being
   * discarded. A no-op once the stack already sits at `MAX_MAP_DIALOG_DEPTH`, so
   * alternating this with `openEventFromPlace` can never grow the stack without
   * bound.
   */
  openPlaceFromEvent: (placeId: MapNodeId) => void;
  /**
   * The place dialog's scoped-log row: an "inside" pusher, mirroring
   * `openPlaceFromEvent`. PUSHES an `"event"` entry naming `id` on top of whatever is
   * already in `mapDialogStack`. Validated the same way `selectWorldEvent` is: an id
   * absent from the current snapshot's `worldEvents` ring leaves the stack untouched.
   * Also a no-op once the stack already sits at `MAX_MAP_DIALOG_DEPTH` (checked
   * before the id validation, so a stale id at the cap still reports as a no-op the
   * same way).
   */
  openEventFromPlace: (id: number) => void;
  /**
   * Pop the top entry off `mapDialogStack`, revealing whatever is beneath it (or
   * emptying the stack, if it held only one entry). The dialogs' own "Back" control
   * and their Esc handler (while a "Back" is available) call it.
   */
  popMapDialog: () => void;
  /**
   * Empty `mapDialogStack` in one step, closing every dialog on it regardless of
   * depth. The × button on either dialog, the backdrop click, and the Esc handler
   * (once no "Back" is available, i.e. at the root entry) all call it.
   */
  clearMapDialogStack: () => void;
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
 * A shared empty dialog stack, so every closer/opener that clears
 * `mapDialogStack` hands back the SAME reference instead of allocating a fresh `[]`
 * on every call. Never mutated: pushes, pops, and resets all build fresh arrays.
 */
const EMPTY_MAP_DIALOG_STACK: MapModalEntry[] = [];

/**
 * Hard cap on `mapDialogStack`'s depth (GH124 follow-up): the two "inside" pushers,
 * `openPlaceFromEvent` and `openEventFromPlace`, push onto whatever is already there
 * rather than resetting it, so alternating "Open place" and a scoped-log row could
 * otherwise grow the stack without bound. A realistic session never nests anywhere
 * near this deep — this exists only to stop that pathological growth, not to bound
 * anything a real session would hit.
 */
export const MAX_MAP_DIALOG_DEPTH = 12;

/**
 * The trace-dialog fields, both cleared, plus an empty map/event dialog stack: the
 * shape `selectFinding`/`selectDecision` spread to heal the "only one dialog KIND
 * open" invariant on both their open branch (own field overridden after the spread)
 * and their toggle-off/no-op branch (returned as-is), and the shape the three
 * "outside" map/event openers spread to clear any open trace dialog before resetting
 * the stack themselves. One constant instead of hand-writing all three fields in
 * every opener means a future fourth field, whenever one is added, only needs adding
 * here to stay covered everywhere, rather than drifting the way individual openers'
 * toggle-off branches did before this pattern (Codex review, GH105-PLAN.md).
 */
const NO_MODAL_SELECTION = {
  selection: null,
  decisionSelection: null,
  mapDialogStack: EMPTY_MAP_DIALOG_STACK,
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
  mapDialogStack: EMPTY_MAP_DIALOG_STACK,
  transport: { frozen: false, speed: 1 },
  flashes: new Map(),
  runToken: 0,
  // Reconcile both trace selections on every snapshot, independently. `seq` is stable
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
      // Unlike a `"place"` entry (names a fixed world.json fixture, never evicted), an
      // `"event"` entry names an id in the bounded world-event ring, so it needs the
      // same per-publish reconciliation `selection`/`decisionSelection` already get:
      // filter out any `"event"` entry whose id has aged out of the ring, wherever it
      // sits in the stack — not just when it is the top entry — so a Back can never
      // land on a dialog with nothing left to show. A stale `"place"` entry can never
      // occur, so every `"place"` entry always survives this filter unchanged.
      if (state.mapDialogStack.length > 0) {
        const liveStack = state.mapDialogStack.filter(
          (entry) =>
            entry.kind === "place" || snapshot.worldEvents.some((event) => event.id === entry.id),
        );
        if (liveStack.length !== state.mapDialogStack.length) {
          next.mapDialogStack = liveStack;
        }
      }
      return next;
    }),
  setAlgorithmSource: (source) => set({ source }),
  setError: (error) => set({ error }),
  setOverlayOpen: (open) => set({ overlayOpen: open }),
  setRunPending: (pending) => set({ runPending: pending }),
  // The trace dialog is single, so selecting either kind always clears the other, and
  // at most one of the two store-tracked dialog KINDS (trace, or the map/event stack)
  // is ever open, so this also empties mapDialogStack — on the toggle-off branch too,
  // via NO_MODAL_SELECTION, not just the open branch. A selection is stored only for a
  // seq present in the current snapshot, so `selection !== null` always implies a live
  // finding to render (GH105-PLAN.md): (1) re-select of the same seq toggles off AND
  // heals a stray map/event stack; (2) validate the seq against the snapshot; (3) only
  // for a valid seq, set the selection and clear the other fields. A stale seq returns
  // `state` itself, not `{}` — a genuine Zustand no-op that leaves any open dialog
  // untouched and publishes no new root state.
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
  // The three "outside" openers below (selectMapNode/selectMapTrain/selectWorldEvent)
  // are reachable only while mapDialogStack is already empty — App's opener guards
  // block a map click or a main-log-row click while any dialog is open, and the shell
  // is inert behind one anyway — so each one plainly RESETS the stack to a fresh
  // single entry rather than needing its own toggle-off case the way selectFinding/
  // selectDecision do. No snapshot-presence validation for a `"place"` entry, unlike
  // selectWorldEvent: every node/train id it can name is a fixed world.json fixture,
  // never evicted.
  selectMapNode: (id) =>
    set(() => ({
      ...NO_MODAL_SELECTION,
      mapDialogStack: [{ kind: "place", selection: { kind: "node", id } }],
    })),
  selectMapTrain: (actorId) =>
    set(() => ({
      ...NO_MODAL_SELECTION,
      mapDialogStack: [{ kind: "place", selection: { kind: "train", actorId } }],
    })),
  // Validates the id against the live ring, mirroring `selectFinding`/`selectDecision`:
  // an id absent from `state.snapshot.worldEvents` is stale (its row already aged out,
  // or the dialog is frozen past a publish that evicted it) and is ignored rather than
  // stored, so the shell can never go inert with no dialog to show for it.
  selectWorldEvent: (id) =>
    set((state) => {
      if (!state.snapshot.worldEvents.some((event) => event.id === id)) {
        return state; // stale id: genuine no-op, leaves any open dialog untouched
      }
      return { ...NO_MODAL_SELECTION, mapDialogStack: [{ kind: "event", id }] };
    }),
  // The two "inside" pushers below (openPlaceFromEvent/openEventFromPlace) only ever
  // run from within an already-open dialog, so — unlike the three "outside" openers
  // above — they PUSH onto whatever is already in mapDialogStack instead of resetting
  // it, keeping the dialog they were clicked from in the stack for a later Back. Never
  // touch the trace fields: the stack being non-empty already implies no trace dialog
  // is open (the two dialog kinds stay mutually exclusive from every direction), so
  // there is nothing to heal. Both no-op at MAX_MAP_DIALOG_DEPTH, so alternating "Open
  // place" and a scoped-log row can never grow the stack past the cap.
  openPlaceFromEvent: (placeId) =>
    set((state) => {
      if (state.mapDialogStack.length >= MAX_MAP_DIALOG_DEPTH) {
        return state; // at the cap: do not change the stack
      }
      return {
        mapDialogStack: [
          ...state.mapDialogStack,
          { kind: "place", selection: { kind: "node", id: placeId } },
        ],
      };
    }),
  // Validated the same way selectWorldEvent is: an id absent from the live ring is
  // stale and leaves the stack untouched rather than pushing a dialog with nothing to
  // show. The cap check runs first, so a stale id at the cap still reads as a plain
  // no-op rather than one masking the other.
  openEventFromPlace: (id) =>
    set((state) => {
      if (state.mapDialogStack.length >= MAX_MAP_DIALOG_DEPTH) {
        return state; // at the cap: do not change the stack
      }
      if (!state.snapshot.worldEvents.some((event) => event.id === id)) {
        return state; // stale id: do not change the stack
      }
      return { mapDialogStack: [...state.mapDialogStack, { kind: "event", id }] };
    }),
  popMapDialog: () =>
    set((state) => {
      if (state.mapDialogStack.length === 0) {
        return state; // defensive: neither dialog ever calls this on an empty stack
      }
      return { mapDialogStack: state.mapDialogStack.slice(0, -1) };
    }),
  clearMapDialogStack: () => set({ mapDialogStack: EMPTY_MAP_DIALOG_STACK }),
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
