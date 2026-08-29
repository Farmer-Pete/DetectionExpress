import { beforeEach, describe, expect, it } from "vitest";
import { referenceSource } from "../sim/scenarios/kiosk-pin-attack/reference";
import { emptySnapshot, type SimSnapshot } from "../sim/snapshot";
import { getGraph, useGameStore } from "./store";
import { LEVEL_SEED } from "./tuning";

const initial = useGameStore.getState();

beforeEach(() => {
  useGameStore.setState({
    nodes: initial.nodes,
    edges: initial.edges,
    snapshot: emptySnapshot(),
    source: referenceSource,
    seed: LEVEL_SEED,
    error: null,
    sourceLocked: false,
  });
});

describe("store", () => {
  it("seeds the four-node chain the validator accepts", () => {
    const graph = getGraph();
    expect(graph.nodes.map((node) => node.kind)).toEqual(["ingest", "normalize", "match", "sink"]);
    expect(graph.edges).toHaveLength(3);
  });

  it("seeds the Algorithm source and the level seed", () => {
    expect(useGameStore.getState().source).toBe(referenceSource);
    expect(useGameStore.getState().seed).toBe(LEVEL_SEED);
    expect(useGameStore.getState().error).toBeNull();
  });

  it("edits the Algorithm source through setAlgorithmSource", () => {
    useGameStore.getState().setAlgorithmSource("export function match(){ return null; }");
    expect(useGameStore.getState().source).toContain("return null");
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
    };
    useGameStore.getState().setSnapshot(snapshot);
    expect(useGameStore.getState().snapshot).toEqual(snapshot);
  });

  it("applies node change handlers", () => {
    useGameStore
      .getState()
      .onNodesChange([{ id: "sink", type: "position", position: { x: 900, y: 200 } }]);
    const sink = useGameStore.getState().nodes.find((node) => node.id === "sink");
    expect(sink?.position).toEqual({ x: 900, y: 200 });
  });

  it("applies edge change handlers", () => {
    useGameStore.getState().onEdgesChange([{ id: "e1", type: "select", selected: true }]);
    const edge = useGameStore.getState().edges.find((candidate) => candidate.id === "e1");
    expect(edge?.selected).toBe(true);
  });

  it("starts unlocked and toggles the source lock through setSourceLocked", () => {
    expect(useGameStore.getState().sourceLocked).toBe(false);
    useGameStore.getState().setSourceLocked(true);
    expect(useGameStore.getState().sourceLocked).toBe(true);
    useGameStore.getState().setSourceLocked(false);
    expect(useGameStore.getState().sourceLocked).toBe(false);
  });
});
