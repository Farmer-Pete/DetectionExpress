import { beforeEach, describe, expect, it } from "vitest";
import type { LiveFinding } from "../sim/correctness";
import { referenceSource } from "../sim/scenarios/kiosk-pin-attack/reference";
import { emptySnapshot, type SimSnapshot } from "../sim/snapshot";
import { getGraph, useGameStore } from "./store";
import { LEVEL_SEED } from "./tuning";

beforeEach(() => {
  useGameStore.setState({
    snapshot: emptySnapshot(),
    source: referenceSource,
    localAlgorithm: null,
    seed: LEVEL_SEED,
    error: null,
    sourceLocked: false,
    runPending: false,
    selection: null,
  });
});

/** A LiveFinding fixture: the reconciliation logic reads only its `seq`. */
function finding(seq: number): LiveFinding {
  return {
    finding: { alert: { eventIds: [], reason: "pin_brute_force", at: 0 } },
    state: "hit",
    reason: "pin_brute_force",
    eventIds: [],
    at: 0,
    seq,
  };
}

/** A snapshot carrying the given findings, otherwise empty. */
function snapshotWith(findings: LiveFinding[]): SimSnapshot {
  return { ...emptySnapshot(), findings };
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
      backlog: 42,
      throughput: 7,
      nodes: { sink: { heat: 0.5 } },
      edges: { e3: { inRate: 8, outRate: 6 } },
      correctness: { rolling: 90, caught: 3, missed: 1, falseAlerts: 0 },
      compute: 0.05,
      status: "running",
      failureReason: null,
      admitted: 50,
      completed: 8,
      findings: [],
      events: [],
      processed: 8,
    };
    useGameStore.getState().setSnapshot(snapshot);
    expect(useGameStore.getState().snapshot).toEqual(snapshot);
  });

  it("starts in source mode and holds a local override through setLocalAlgorithm", () => {
    expect(useGameStore.getState().localAlgorithm).toBeNull();
    useGameStore.getState().setLocalAlgorithm({ path: "/src/algorithms/kiosk.ts", version: 4 });
    expect(useGameStore.getState().localAlgorithm).toEqual({
      path: "/src/algorithms/kiosk.ts",
      version: 4,
    });
    useGameStore.getState().setLocalAlgorithm(null);
    expect(useGameStore.getState().localAlgorithm).toBeNull();
  });

  it("starts unlocked and toggles the source lock through setSourceLocked", () => {
    expect(useGameStore.getState().sourceLocked).toBe(false);
    useGameStore.getState().setSourceLocked(true);
    expect(useGameStore.getState().sourceLocked).toBe(true);
    useGameStore.getState().setSourceLocked(false);
    expect(useGameStore.getState().sourceLocked).toBe(false);
  });

  it("starts with no run pending and toggles it through setRunPending", () => {
    expect(useGameStore.getState().runPending).toBe(false);
    useGameStore.getState().setRunPending(true);
    expect(useGameStore.getState().runPending).toBe(true);
    useGameStore.getState().setRunPending(false);
    expect(useGameStore.getState().runPending).toBe(false);
  });
});

describe("store selection", () => {
  it("starts with no selection", () => {
    expect(useGameStore.getState().selection).toBeNull();
  });

  it("selects a finding by seq through selectFinding", () => {
    useGameStore.getState().selectFinding(7);
    expect(useGameStore.getState().selection).toEqual({ seq: 7 });
  });

  it("toggles: re-selecting the same seq clears the selection", () => {
    useGameStore.getState().selectFinding(7);
    useGameStore.getState().selectFinding(7);
    expect(useGameStore.getState().selection).toBeNull();
  });

  it("switches selection when a different seq is selected", () => {
    useGameStore.getState().selectFinding(7);
    useGameStore.getState().selectFinding(9);
    expect(useGameStore.getState().selection).toEqual({ seq: 9 });
  });

  it("clears the selection through clearSelection", () => {
    useGameStore.getState().selectFinding(7);
    useGameStore.getState().clearSelection();
    expect(useGameStore.getState().selection).toBeNull();
  });

  it("setSnapshot keeps a selection whose seq is still present", () => {
    useGameStore.getState().selectFinding(3);
    useGameStore.getState().setSnapshot(snapshotWith([finding(1), finding(3)]));
    expect(useGameStore.getState().selection).toEqual({ seq: 3 });
  });

  it("setSnapshot clears a selection whose seq aged out of the findings", () => {
    useGameStore.getState().selectFinding(3);
    useGameStore.getState().setSnapshot(snapshotWith([finding(1), finding(2)]));
    expect(useGameStore.getState().selection).toBeNull();
  });

  it("setSnapshot clears a selection when a run restart resets seq from zero", () => {
    useGameStore.getState().selectFinding(42);
    // A fresh run's first snapshot carries low seqs; the old seq 42 is gone.
    useGameStore.getState().setSnapshot(snapshotWith([finding(0), finding(1)]));
    expect(useGameStore.getState().selection).toBeNull();
  });

  it("setSnapshot leaves a null selection null", () => {
    useGameStore.getState().setSnapshot(snapshotWith([finding(1)]));
    expect(useGameStore.getState().selection).toBeNull();
  });
});
