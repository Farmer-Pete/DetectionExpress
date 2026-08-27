import { beforeEach, describe, expect, it } from "bun:test";
import type { SimSnapshot } from "../sim/snapshot";
import { getGraph, getRate, useGameStore } from "./store";
import { ARRIVAL_RATE } from "./tuning";

const initial = useGameStore.getState();

beforeEach(() => {
  useGameStore.setState({ nodes: initial.nodes, edges: initial.edges, snapshot: initial.snapshot });
});

describe("store", () => {
  it("seeds a linear Ingest -> Sink graph the validator accepts", () => {
    const graph = getGraph();
    expect(graph.nodes.map((node) => node.kind)).toEqual(["ingest", "sink"]);
    expect(graph.edges).toHaveLength(1);
  });

  it("reads each node's rate through getRate", () => {
    expect(getRate("ingest")).toBe(ARRIVAL_RATE);
    expect(getRate("sink")).toBe(10);
  });

  it("writes the Sink mu with setSinkRate, so getRate follows", () => {
    useGameStore.getState().setSinkRate(3.5);
    expect(getRate("sink")).toBe(3.5);
    expect(getRate("ingest")).toBe(ARRIVAL_RATE); // untouched
  });

  it("stores a published snapshot", () => {
    const snapshot: SimSnapshot = {
      backlog: 42,
      throughput: 7,
      nodes: { sink: { heat: 0.5 } },
      edges: { "ingest-sink": { inRate: 8, outRate: 6 } },
    };
    useGameStore.getState().setSnapshot(snapshot);
    expect(useGameStore.getState().snapshot).toEqual(snapshot);
  });

  it("applies node change handlers", () => {
    useGameStore
      .getState()
      .onNodesChange([{ id: "sink", type: "position", position: { x: 500, y: 200 } }]);
    const sink = useGameStore.getState().nodes.find((node) => node.id === "sink");
    expect(sink?.position).toEqual({ x: 500, y: 200 });
  });

  it("applies edge change handlers", () => {
    useGameStore.getState().onEdgesChange([{ id: "ingest-sink", type: "select", selected: true }]);
    const edge = useGameStore.getState().edges.find((candidate) => candidate.id === "ingest-sink");
    expect(edge?.selected).toBe(true);
  });
});
