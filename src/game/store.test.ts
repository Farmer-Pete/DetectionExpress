import { beforeEach, describe, expect, it } from "vitest";
import type { Decision, LiveFinding } from "../sim/correctness";
import { emptySnapshot, type SimSnapshot } from "../sim/snapshot";
import type { WorldLogEvent } from "../sim/world-log";
import { referenceSource } from "./engine-source";
import type { MapModalEntry } from "./store";
import { getGraph, MAX_MAP_DIALOG_DEPTH, useGameStore } from "./store";
import { LEVEL_SEED } from "./tuning";

beforeEach(() => {
  useGameStore.setState({
    snapshot: emptySnapshot(),
    source: referenceSource,
    seed: LEVEL_SEED,
    error: null,
    overlayOpen: false,
    runPending: false,
    selection: null,
    decisionSelection: null,
    mapDialogStack: [],
    transport: { frozen: false, speed: 1 },
    flashes: new Map(),
    runToken: 0,
  });
});

/** A LiveFinding fixture: the reconciliation logic reads only its `seq`. */
function finding(seq: number): LiveFinding {
  // A real anchor in BOTH the nested alert.eventIds and the top-level snapshot, so the
  // fixture stays a consistent LiveFinding even though this test only reads its seq.
  return {
    finding: { alert: { eventIds: [seq], reason: "pin_brute_force", at: 0 }, eventId: seq },
    state: "hit",
    reason: "pin_brute_force",
    eventIds: [seq],
    at: 0,
    seq,
    citedEvents: [],
  };
}

/** A false Decision fixture: the reconciliation logic reads only its `seq`. */
function decision(seq: number): Decision {
  return {
    outcome: "false",
    seq,
    at: 0,
    resolvedAt: 0,
    finding: { alert: { eventIds: [seq], reason: "pin_brute_force", at: 0 }, eventId: seq },
    citedEvents: [],
    liveSeq: seq,
  };
}

/** A snapshot carrying the given findings, otherwise empty. */
function snapshotWith(findings: LiveFinding[]): SimSnapshot {
  return { ...emptySnapshot(), findings };
}

/** A snapshot carrying the given decisions, otherwise empty. */
function snapshotWithDecisions(decisions: Decision[]): SimSnapshot {
  return { ...emptySnapshot(), decisions };
}

/** A WorldLogEvent fixture: the reconciliation logic reads only its `id`. */
function worldEvent(id: number): WorldLogEvent {
  return {
    id,
    ts: 12,
    sensor: "fare-gate",
    placeId: "cen",
    chipNode: "cen:gate",
    reading: {
      sensor: "fare-gate",
      reading: {
        ts: 12,
        card: "card-1",
        station: "cen",
        line: "red",
        direction: "in",
        result: "ok",
        balance: 50,
      },
    },
    scored: false,
  };
}

/** A snapshot carrying the given world-log events, otherwise empty. */
function snapshotWithWorldEvents(events: WorldLogEvent[]): SimSnapshot {
  return { ...emptySnapshot(), worldEvents: events };
}

describe("store", () => {
  it("returns the fixed four-node chain from getGraph", () => {
    const graph = getGraph();
    expect(graph.nodes.map((node) => node.kind)).toEqual(["ingest", "normalize", "detect", "sink"]);
    expect(graph.edges).toHaveLength(3);
  });

  it("no longer exposes the graph as editable store state", () => {
    const keys = Object.keys(useGameStore.getState());
    expect(keys).not.toContain("nodes");
    expect(keys).not.toContain("edges");
    expect(keys).not.toContain("onNodesChange");
    expect(keys).not.toContain("onEdgesChange");
  });

  it("seeds the Algorithm source and the level seed", () => {
    expect(useGameStore.getState().source).toBe(referenceSource);
    expect(useGameStore.getState().seed).toBe(LEVEL_SEED);
    expect(useGameStore.getState().error).toBeNull();
  });

  it("edits the Algorithm source through setAlgorithmSource", () => {
    useGameStore.getState().setAlgorithmSource("export function detect(){ return []; }");
    expect(useGameStore.getState().source).toContain("return []");
  });

  it("holds and clears the error through setError", () => {
    useGameStore.getState().setError({ phase: "detect", message: "boom" });
    expect(useGameStore.getState().error).toEqual({ phase: "detect", message: "boom" });
    useGameStore.getState().setError(null);
    expect(useGameStore.getState().error).toBeNull();
  });

  it("stores a published snapshot", () => {
    const snapshot: SimSnapshot = {
      ...emptySnapshot(),
      queued: 42,
      throughput: 7,
      correctness: { rolling: 90, caught: 3, missed: 1, falseAlerts: 0 },
      compute: 0.05,
      status: "running",
      failureReason: null,
      admitted: 50,
      completed: 8,
      processed: 8,
    };
    useGameStore.getState().setSnapshot(snapshot);
    expect(useGameStore.getState().snapshot).toEqual(snapshot);
  });

  it("round-trips a snapshot carrying non-empty map fields through setSnapshot (GH117 Part E)", () => {
    const snapshot: SimSnapshot = {
      ...emptySnapshot(),
      actors: [
        {
          id: "attacker-1",
          kind: "pin-attacker",
          presence: { kind: "at", node: "k1", fromTick: 0, untilTick: "open" },
        },
      ],
      flashes: [{ id: 1, kind: "pinfail", node: "k1", atTick: 5 }],
      doors: [{ node: "d1", open: true }],
      crowds: [{ node: "c1", persons: 3, grants: 2 }],
      nowTick: 42,
    };
    useGameStore.getState().setSnapshot(snapshot);
    expect(useGameStore.getState().snapshot).toEqual(snapshot);
  });

  it("starts closed and toggles the overlay-open flag through setOverlayOpen", () => {
    expect(useGameStore.getState().overlayOpen).toBe(false);
    useGameStore.getState().setOverlayOpen(true);
    expect(useGameStore.getState().overlayOpen).toBe(true);
    useGameStore.getState().setOverlayOpen(false);
    expect(useGameStore.getState().overlayOpen).toBe(false);
  });

  it("starts with no run pending and toggles it through setRunPending", () => {
    expect(useGameStore.getState().runPending).toBe(false);
    useGameStore.getState().setRunPending(true);
    expect(useGameStore.getState().runPending).toBe(true);
    useGameStore.getState().setRunPending(false);
    expect(useGameStore.getState().runPending).toBe(false);
  });

  it("starts unfrozen and mirrors the transport freeze through setFrozen", () => {
    expect(useGameStore.getState().transport.frozen).toBe(false);
    useGameStore.getState().setFrozen(true);
    expect(useGameStore.getState().transport.frozen).toBe(true);
    useGameStore.getState().setFrozen(false);
    expect(useGameStore.getState().transport.frozen).toBe(false);
  });

  it("starts at speed 1 and mirrors the transport speed through setSpeed", () => {
    expect(useGameStore.getState().transport.speed).toBe(1);
    useGameStore.getState().setSpeed(2);
    expect(useGameStore.getState().transport.speed).toBe(2);
    useGameStore.getState().setSpeed(0.5);
    expect(useGameStore.getState().transport.speed).toBe(0.5);
  });

  it("keeps speed when freeze toggles, and freeze when speed changes", () => {
    useGameStore.getState().setSpeed(2);
    useGameStore.getState().setFrozen(true);
    expect(useGameStore.getState().transport).toEqual({ frozen: true, speed: 2 });
    useGameStore.getState().setSpeed(0.5);
    expect(useGameStore.getState().transport).toEqual({ frozen: true, speed: 0.5 });
  });
});

describe("store selection", () => {
  it("starts with no selection", () => {
    expect(useGameStore.getState().selection).toBeNull();
  });

  it("selects a finding by seq through selectFinding, when the seq is present in the snapshot", () => {
    useGameStore.getState().setSnapshot(snapshotWith([finding(7)]));
    useGameStore.getState().selectFinding(7);
    expect(useGameStore.getState().selection).toEqual({ seq: 7 });
  });

  it("toggles: re-selecting the same seq clears the selection", () => {
    useGameStore.getState().setSnapshot(snapshotWith([finding(7)]));
    useGameStore.getState().selectFinding(7);
    useGameStore.getState().selectFinding(7);
    expect(useGameStore.getState().selection).toBeNull();
  });

  it("toggling a finding off also heals a non-empty map/event dialog stack left open by a stray click (Codex review gap)", () => {
    useGameStore.getState().setSnapshot(snapshotWith([finding(7)]));
    useGameStore.getState().selectFinding(7);
    // Manufacture the conflicting state the toggle-off branch used to leave standing.
    useGameStore.setState({
      mapDialogStack: [{ kind: "place", selection: { kind: "node", id: "cen" } }],
    });
    useGameStore.getState().selectFinding(7); // re-select toggles off
    expect(useGameStore.getState().selection).toBeNull();
    expect(useGameStore.getState().mapDialogStack).toEqual([]);
  });

  it("switches selection when a different seq is selected", () => {
    useGameStore.getState().setSnapshot(snapshotWith([finding(7), finding(9)]));
    useGameStore.getState().selectFinding(7);
    useGameStore.getState().selectFinding(9);
    expect(useGameStore.getState().selection).toEqual({ seq: 9 });
  });

  it("clears the selection through clearSelection", () => {
    useGameStore.getState().setSnapshot(snapshotWith([finding(7)]));
    useGameStore.getState().selectFinding(7);
    useGameStore.getState().clearSelection();
    expect(useGameStore.getState().selection).toBeNull();
  });

  it("leaves the selection null when the seq is absent from the current snapshot's findings", () => {
    useGameStore.getState().setSnapshot(snapshotWith([finding(1)]));
    useGameStore.getState().selectFinding(99);
    expect(useGameStore.getState().selection).toBeNull();
  });

  it("leaves an open decision selection untouched, and publishes no new state, on a stale selectFinding", () => {
    useGameStore.getState().setSnapshot({
      ...emptySnapshot(),
      findings: [finding(1)],
      decisions: [decision(2)],
    });
    useGameStore.getState().selectDecision(2);
    const before = useGameStore.getState();
    useGameStore.getState().selectFinding(99); // 99 is absent from findings: stale
    const after = useGameStore.getState();
    expect(Object.is(before, after)).toBe(true);
    expect(useGameStore.getState().decisionSelection).toEqual({ seq: 2 });
    expect(useGameStore.getState().selection).toBeNull();
  });

  it("setSnapshot keeps a selection whose seq is still present", () => {
    useGameStore.getState().setSnapshot(snapshotWith([finding(3)])); // seed: seq 3 exists
    useGameStore.getState().selectFinding(3);
    useGameStore.getState().setSnapshot(snapshotWith([finding(1), finding(3)]));
    expect(useGameStore.getState().selection).toEqual({ seq: 3 });
  });

  it("setSnapshot clears a selection whose seq aged out of the findings", () => {
    useGameStore.getState().setSnapshot(snapshotWith([finding(3)])); // seed: seq 3 exists
    useGameStore.getState().selectFinding(3);
    useGameStore.getState().setSnapshot(snapshotWith([finding(1), finding(2)]));
    expect(useGameStore.getState().selection).toBeNull();
  });

  it("clears a stale selection across a run restart so a reused seq cannot alias", () => {
    useGameStore.getState().setSnapshot(snapshotWith([finding(0)])); // seed: seq 0 exists
    useGameStore.getState().selectFinding(0);
    // A restart publishes an empty snapshot first (run-controller), which clears the
    // selection because seq 0 is no longer present.
    useGameStore.getState().setSnapshot(snapshotWith([]));
    expect(useGameStore.getState().selection).toBeNull();
    // The fresh run then reuses seq 0 for a different finding; selection stays cleared,
    // so the old selection never aliases the new seq-0 finding.
    useGameStore.getState().setSnapshot(snapshotWith([finding(0)]));
    expect(useGameStore.getState().selection).toBeNull();
  });

  it("setSnapshot leaves a null selection null", () => {
    useGameStore.getState().setSnapshot(snapshotWith([finding(1)]));
    expect(useGameStore.getState().selection).toBeNull();
  });

  it("selecting a finding closes any open map/event dialog stack, so at most one dialog kind is open", () => {
    useGameStore.getState().setSnapshot(snapshotWith([finding(3)]));
    useGameStore.setState({
      mapDialogStack: [
        { kind: "place", selection: { kind: "node", id: "cen" } },
        { kind: "event", id: 5 },
      ],
    });
    useGameStore.getState().selectFinding(3);
    expect(useGameStore.getState().selection).toEqual({ seq: 3 });
    expect(useGameStore.getState().mapDialogStack).toEqual([]);
  });
});

describe("store decision selection (T10)", () => {
  it("starts with no decision selection", () => {
    expect(useGameStore.getState().decisionSelection).toBeNull();
  });

  it("selects a decision by seq through selectDecision, when the seq is present in the snapshot", () => {
    useGameStore.getState().setSnapshot(snapshotWithDecisions([decision(7)]));
    useGameStore.getState().selectDecision(7);
    expect(useGameStore.getState().decisionSelection).toEqual({ seq: 7 });
  });

  it("toggles: re-selecting the same seq clears the decision selection", () => {
    useGameStore.getState().setSnapshot(snapshotWithDecisions([decision(7)]));
    useGameStore.getState().selectDecision(7);
    useGameStore.getState().selectDecision(7);
    expect(useGameStore.getState().decisionSelection).toBeNull();
  });

  it("toggling a decision off also heals a non-empty map/event dialog stack left open by a stray click (Codex review gap)", () => {
    useGameStore.getState().setSnapshot(snapshotWithDecisions([decision(7)]));
    useGameStore.getState().selectDecision(7);
    useGameStore.setState({
      mapDialogStack: [{ kind: "place", selection: { kind: "train", actorId: "T1" } }],
    });
    useGameStore.getState().selectDecision(7); // re-select toggles off
    expect(useGameStore.getState().decisionSelection).toBeNull();
    expect(useGameStore.getState().mapDialogStack).toEqual([]);
  });

  it("switches decision selection when a different seq is selected", () => {
    useGameStore.getState().setSnapshot(snapshotWithDecisions([decision(7), decision(9)]));
    useGameStore.getState().selectDecision(7);
    useGameStore.getState().selectDecision(9);
    expect(useGameStore.getState().decisionSelection).toEqual({ seq: 9 });
  });

  it("clears the decision selection through clearSelection", () => {
    useGameStore.getState().setSnapshot(snapshotWithDecisions([decision(7)]));
    useGameStore.getState().selectDecision(7);
    useGameStore.getState().clearSelection();
    expect(useGameStore.getState().decisionSelection).toBeNull();
  });

  it("leaves the decision selection null when the seq is absent from the current snapshot's decisions", () => {
    useGameStore.getState().setSnapshot(snapshotWithDecisions([decision(1)]));
    useGameStore.getState().selectDecision(99);
    expect(useGameStore.getState().decisionSelection).toBeNull();
  });

  it("selecting a finding clears any decision selection (the dialog is single)", () => {
    useGameStore.getState().setSnapshot({
      ...emptySnapshot(),
      findings: [finding(3)],
      decisions: [decision(7)],
    });
    useGameStore.getState().selectDecision(7);
    useGameStore.getState().selectFinding(3);
    expect(useGameStore.getState().decisionSelection).toBeNull();
    expect(useGameStore.getState().selection).toEqual({ seq: 3 });
  });

  it("selecting a decision clears any finding selection (the dialog is single)", () => {
    useGameStore.getState().setSnapshot({
      ...emptySnapshot(),
      findings: [finding(3)],
      decisions: [decision(7)],
    });
    useGameStore.getState().selectFinding(3);
    useGameStore.getState().selectDecision(7);
    expect(useGameStore.getState().selection).toBeNull();
    expect(useGameStore.getState().decisionSelection).toEqual({ seq: 7 });
  });

  it("setSnapshot keeps a decision selection whose seq is still present", () => {
    useGameStore.getState().setSnapshot(snapshotWithDecisions([decision(3)])); // seed: seq 3 exists
    useGameStore.getState().selectDecision(3);
    useGameStore.getState().setSnapshot(snapshotWithDecisions([decision(1), decision(3)]));
    expect(useGameStore.getState().decisionSelection).toEqual({ seq: 3 });
  });

  it("setSnapshot clears a decision selection whose seq left the capped decisions log", () => {
    useGameStore.getState().setSnapshot(snapshotWithDecisions([decision(3)])); // seed: seq 3 exists
    useGameStore.getState().selectDecision(3);
    useGameStore.getState().setSnapshot(snapshotWithDecisions([decision(1), decision(2)]));
    expect(useGameStore.getState().decisionSelection).toBeNull();
  });

  it("setSnapshot leaves a null decision selection null", () => {
    useGameStore.getState().setSnapshot(snapshotWithDecisions([decision(1)]));
    expect(useGameStore.getState().decisionSelection).toBeNull();
  });

  it("reconciles the finding selection and the decision selection independently", () => {
    useGameStore.getState().setSnapshot(snapshotWith([finding(3)])); // seed: seq 3 exists
    useGameStore.getState().selectFinding(3);
    useGameStore.getState().setSnapshot({
      ...emptySnapshot(),
      findings: [finding(3)],
      decisions: [],
    });
    // The finding selection survives; there was never a decision selection to touch.
    expect(useGameStore.getState().selection).toEqual({ seq: 3 });
    expect(useGameStore.getState().decisionSelection).toBeNull();
  });

  it("selecting a decision closes any open map/event dialog stack, so at most one dialog kind is open", () => {
    useGameStore.getState().setSnapshot(snapshotWithDecisions([decision(7)]));
    useGameStore.setState({
      mapDialogStack: [{ kind: "place", selection: { kind: "train", actorId: "T1" } }],
    });
    useGameStore.getState().selectDecision(7);
    expect(useGameStore.getState().decisionSelection).toEqual({ seq: 7 });
    expect(useGameStore.getState().mapDialogStack).toEqual([]);
  });
});

describe("store map/event dialog stack: 'outside' openers (GH124 follow-up, dialog navigation stack)", () => {
  it("starts with an empty stack", () => {
    expect(useGameStore.getState().mapDialogStack).toEqual([]);
  });

  it("selectMapNode resets the stack to one place entry", () => {
    useGameStore.getState().selectMapNode("cen");
    expect(useGameStore.getState().mapDialogStack).toEqual([
      { kind: "place", selection: { kind: "node", id: "cen" } },
    ]);
  });

  it("selectMapTrain resets the stack to one place entry", () => {
    useGameStore.getState().selectMapTrain("T1");
    expect(useGameStore.getState().mapDialogStack).toEqual([
      { kind: "place", selection: { kind: "train", actorId: "T1" } },
    ]);
  });

  it("selectWorldEvent resets the stack to one event entry, when the id is present in the snapshot's worldEvents ring", () => {
    useGameStore.getState().setSnapshot(snapshotWithWorldEvents([worldEvent(5)]));
    useGameStore.getState().selectWorldEvent(5);
    expect(useGameStore.getState().mapDialogStack).toEqual([{ kind: "event", id: 5 }]);
  });

  it("selectWorldEvent leaves the stack untouched when the id is absent from the snapshot's worldEvents ring", () => {
    useGameStore.getState().setSnapshot(snapshotWithWorldEvents([worldEvent(1)]));
    useGameStore.getState().selectWorldEvent(99); // 99 never entered the ring: stale
    expect(useGameStore.getState().mapDialogStack).toEqual([]);
  });

  it("selectWorldEvent leaves an already-open place dialog untouched on a stale id", () => {
    useGameStore.getState().setSnapshot(snapshotWithWorldEvents([worldEvent(1)]));
    useGameStore.getState().selectMapNode("cen");
    useGameStore.getState().selectWorldEvent(99); // stale: no id 99 in the ring
    expect(useGameStore.getState().mapDialogStack).toEqual([
      { kind: "place", selection: { kind: "node", id: "cen" } },
    ]);
  });

  it("a stale id can never wedge the dialog: after the id ages out of the ring, re-selecting it opens nothing", () => {
    useGameStore.getState().setSnapshot(snapshotWithWorldEvents([worldEvent(5)]));
    useGameStore.getState().selectWorldEvent(5);
    expect(useGameStore.getState().mapDialogStack).toEqual([{ kind: "event", id: 5 }]);
    // The ring evicts id 5 (e.g. a fresh publish that aged it out while frozen).
    useGameStore.getState().setSnapshot(snapshotWithWorldEvents([worldEvent(6)]));
    expect(useGameStore.getState().mapDialogStack).toEqual([]);
    // A later click replaying the same stale id opens nothing rather than wedging.
    useGameStore.getState().selectWorldEvent(5);
    expect(useGameStore.getState().mapDialogStack).toEqual([]);
  });

  it("selectMapNode/selectMapTrain/selectWorldEvent all clear any open trace selection", () => {
    useGameStore.getState().setSnapshot(snapshotWithWorldEvents([worldEvent(5)]));
    for (const open of [
      () => useGameStore.getState().selectMapNode("cen"),
      () => useGameStore.getState().selectMapTrain("T1"),
      () => useGameStore.getState().selectWorldEvent(5),
    ]) {
      useGameStore.setState({
        selection: { seq: 1 },
        decisionSelection: { seq: 2 },
        mapDialogStack: [],
      });
      open();
      expect(useGameStore.getState().selection).toBeNull();
      expect(useGameStore.getState().decisionSelection).toBeNull();
    }
  });
});

describe("store map/event dialog stack: 'inside' pushers (GH124 follow-up, dialog navigation stack)", () => {
  it("openPlaceFromEvent pushes a place entry on top of an existing stack, keeping what is below", () => {
    useGameStore.setState({ mapDialogStack: [{ kind: "event", id: 5 }] });
    useGameStore.getState().openPlaceFromEvent("cen");
    expect(useGameStore.getState().mapDialogStack).toEqual([
      { kind: "event", id: 5 },
      { kind: "place", selection: { kind: "node", id: "cen" } },
    ]);
  });

  it("openEventFromPlace pushes an event entry on top of an existing stack, when the id is present in the snapshot's worldEvents ring", () => {
    useGameStore.getState().setSnapshot(snapshotWithWorldEvents([worldEvent(5)]));
    useGameStore.setState({
      mapDialogStack: [{ kind: "place", selection: { kind: "node", id: "cen" } }],
    });
    useGameStore.getState().openEventFromPlace(5);
    expect(useGameStore.getState().mapDialogStack).toEqual([
      { kind: "place", selection: { kind: "node", id: "cen" } },
      { kind: "event", id: 5 },
    ]);
  });

  it("openEventFromPlace leaves the stack untouched when the id is absent from the snapshot's worldEvents ring", () => {
    useGameStore.getState().setSnapshot(snapshotWithWorldEvents([worldEvent(1)]));
    const before = [{ kind: "place" as const, selection: { kind: "node" as const, id: "cen" } }];
    useGameStore.setState({ mapDialogStack: before });
    useGameStore.getState().openEventFromPlace(99); // stale: no id 99 in the ring
    expect(useGameStore.getState().mapDialogStack).toEqual(before);
  });

  it("neither pusher touches an open trace selection: the stack being non-empty already implies none is open", () => {
    useGameStore.getState().setSnapshot(snapshotWithWorldEvents([worldEvent(5)]));
    useGameStore.setState({ mapDialogStack: [{ kind: "event", id: 5 }] });
    useGameStore.getState().openPlaceFromEvent("cen");
    expect(useGameStore.getState().selection).toBeNull();
    expect(useGameStore.getState().decisionSelection).toBeNull();
  });
});

describe("store map/event dialog stack: MAX_MAP_DIALOG_DEPTH cap (GH124 follow-up, bounded stack)", () => {
  /** A stack of `length` place entries — enough to exercise the cap without caring
   *  about the id validation either pusher separately does. */
  function fullStack(length: number): MapModalEntry[] {
    return Array.from({ length }, (_, i) => ({
      kind: "place" as const,
      selection: { kind: "node" as const, id: `n${i}` },
    }));
  }

  it("openPlaceFromEvent still pushes one entry below the cap", () => {
    useGameStore.setState({ mapDialogStack: fullStack(MAX_MAP_DIALOG_DEPTH - 1) });
    useGameStore.getState().openPlaceFromEvent("cen");
    expect(useGameStore.getState().mapDialogStack).toHaveLength(MAX_MAP_DIALOG_DEPTH);
  });

  it("openPlaceFromEvent no-ops once the stack is already at the cap", () => {
    const atCap = fullStack(MAX_MAP_DIALOG_DEPTH);
    useGameStore.setState({ mapDialogStack: atCap });
    useGameStore.getState().openPlaceFromEvent("cen");
    expect(useGameStore.getState().mapDialogStack).toBe(atCap); // unchanged, same reference
  });

  it("openEventFromPlace still pushes one entry below the cap, for a live id", () => {
    useGameStore.getState().setSnapshot(snapshotWithWorldEvents([worldEvent(5)]));
    useGameStore.setState({ mapDialogStack: fullStack(MAX_MAP_DIALOG_DEPTH - 1) });
    useGameStore.getState().openEventFromPlace(5);
    expect(useGameStore.getState().mapDialogStack).toHaveLength(MAX_MAP_DIALOG_DEPTH);
  });

  it("openEventFromPlace no-ops once the stack is already at the cap, even for a live id", () => {
    useGameStore.getState().setSnapshot(snapshotWithWorldEvents([worldEvent(5)]));
    const atCap = fullStack(MAX_MAP_DIALOG_DEPTH);
    useGameStore.setState({ mapDialogStack: atCap });
    useGameStore.getState().openEventFromPlace(5);
    expect(useGameStore.getState().mapDialogStack).toBe(atCap); // unchanged, same reference
  });
});

describe("store map/event dialog stack: back and clear (GH124 follow-up, dialog navigation stack)", () => {
  it("popMapDialog pops the last entry off a multi-entry stack, revealing the one beneath", () => {
    useGameStore.setState({
      mapDialogStack: [
        { kind: "place", selection: { kind: "node", id: "cen" } },
        { kind: "event", id: 5 },
      ],
    });
    useGameStore.getState().popMapDialog();
    expect(useGameStore.getState().mapDialogStack).toEqual([
      { kind: "place", selection: { kind: "node", id: "cen" } },
    ]);
  });

  it("popMapDialog on a single-entry stack empties it", () => {
    useGameStore.setState({
      mapDialogStack: [{ kind: "place", selection: { kind: "node", id: "cen" } }],
    });
    useGameStore.getState().popMapDialog();
    expect(useGameStore.getState().mapDialogStack).toEqual([]);
  });

  it("popMapDialog is a no-op on an already-empty stack", () => {
    useGameStore.getState().popMapDialog();
    expect(useGameStore.getState().mapDialogStack).toEqual([]);
  });

  it("clearMapDialogStack empties the stack regardless of depth", () => {
    useGameStore.setState({
      mapDialogStack: [
        { kind: "place", selection: { kind: "node", id: "cen" } },
        { kind: "event", id: 5 },
      ],
    });
    useGameStore.getState().clearMapDialogStack();
    expect(useGameStore.getState().mapDialogStack).toEqual([]);
  });

  it("setSnapshot filters a stale event entry out of the stack even when it is not the top entry", () => {
    useGameStore.getState().setSnapshot(snapshotWithWorldEvents([worldEvent(5)]));
    useGameStore.setState({
      mapDialogStack: [
        { kind: "event", id: 5 },
        { kind: "place", selection: { kind: "node", id: "cen" } },
      ],
    });
    // A fresh publish whose ring no longer carries id 5: the buried event entry is
    // filtered out, leaving the place entry (still the top) untouched.
    useGameStore.getState().setSnapshot(snapshotWithWorldEvents([]));
    expect(useGameStore.getState().mapDialogStack).toEqual([
      { kind: "place", selection: { kind: "node", id: "cen" } },
    ]);
  });

  it("setSnapshot leaves a stack with no stale event entries untouched (same array reference)", () => {
    useGameStore.getState().setSnapshot(snapshotWithWorldEvents([worldEvent(5)]));
    useGameStore.setState({
      mapDialogStack: [{ kind: "place", selection: { kind: "node", id: "cen" } }],
    });
    const before = useGameStore.getState().mapDialogStack;
    useGameStore.getState().setSnapshot(snapshotWithWorldEvents([worldEvent(5)]));
    expect(useGameStore.getState().mapDialogStack).toBe(before);
  });
});

describe("store fx slice", () => {
  it("spawns a flash and round-trips it through clearFlash", () => {
    useGameStore.getState().spawnFlashes([{ eventId: 5, colorVar: "var(--hunt-1)", gen: 1 }]);
    expect(useGameStore.getState().flashes.get(5)).toEqual({ colorVar: "var(--hunt-1)", gen: 1 });
    useGameStore.getState().clearFlash(5, 1);
    expect(useGameStore.getState().flashes.has(5)).toBe(false);
  });

  it("spawns several flashes from one batch", () => {
    useGameStore.getState().spawnFlashes([
      { eventId: 1, colorVar: "var(--hunt-1)", gen: 1 },
      { eventId: 2, colorVar: "var(--hunt-1)", gen: 1 },
    ]);
    expect(useGameStore.getState().flashes.size).toBe(2);
  });

  it("builds a new Map reference on every spawn, so a shallow-equal selector sees the update", () => {
    const before = useGameStore.getState().flashes;
    useGameStore.getState().spawnFlashes([{ eventId: 1, colorVar: "var(--hunt-1)", gen: 1 }]);
    expect(useGameStore.getState().flashes).not.toBe(before);
  });

  it("leaves a stale-gen clearFlash as a no-op: a newer flash already owns the row", () => {
    useGameStore.getState().spawnFlashes([{ eventId: 5, colorVar: "var(--hunt-2)", gen: 2 }]);
    useGameStore.getState().clearFlash(5, 1); // stale: the row is now on gen 2
    expect(useGameStore.getState().flashes.get(5)).toEqual({ colorVar: "var(--hunt-2)", gen: 2 });
  });

  it("leaves clearFlash on an absent row as a no-op", () => {
    useGameStore.getState().clearFlash(9, 1);
    expect(useGameStore.getState().flashes.has(9)).toBe(false);
  });

  it("starts runToken at 0 and bumps it monotonically", () => {
    expect(useGameStore.getState().runToken).toBe(0);
    useGameStore.getState().bumpRunToken();
    expect(useGameStore.getState().runToken).toBe(1);
    useGameStore.getState().bumpRunToken();
    expect(useGameStore.getState().runToken).toBe(2);
  });
});
