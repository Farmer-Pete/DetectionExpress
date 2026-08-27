import { describe, expect, it } from "bun:test";
import { type GraphEdge, type GraphNode, validateLinearChain } from "./graph";

/** The canonical four-node chain: ingest -> normalize -> match -> sink. */
const chain: { nodes: GraphNode[]; edges: GraphEdge[] } = {
  nodes: [
    { id: "ingest", kind: "ingest" },
    { id: "normalize", kind: "normalize" },
    { id: "match", kind: "match" },
    { id: "sink", kind: "sink" },
  ],
  edges: [
    { id: "e1", source: "ingest", target: "normalize" },
    { id: "e2", source: "normalize", target: "match" },
    { id: "e3", source: "match", target: "sink" },
  ],
};

describe("validateLinearChain", () => {
  it("accepts the four-node chain and returns its ordered ids", () => {
    const result = validateLinearChain(chain.nodes, chain.edges);
    expect(result.nodeIds).toEqual(["ingest", "normalize", "match", "sink"]);
    expect(result.edgeIds).toEqual(["e1", "e2", "e3"]);
  });

  it("accepts nodes given out of order, but returns them in chain order", () => {
    const result = validateLinearChain(
      [
        { id: "match", kind: "match" },
        { id: "sink", kind: "sink" },
        { id: "ingest", kind: "ingest" },
        { id: "normalize", kind: "normalize" },
      ],
      chain.edges,
    );
    expect(result.nodeIds).toEqual(["ingest", "normalize", "match", "sink"]);
  });

  it("rejects an unknown node kind", () => {
    const nodes = chain.nodes.map((n) => (n.id === "match" ? { id: "match", kind: "detect" } : n));
    expect(() => validateLinearChain(nodes, chain.edges)).toThrow(/unknown/i);
  });

  it("rejects a missing node (no Sink)", () => {
    const nodes = chain.nodes.filter((n) => n.kind !== "sink");
    expect(() => validateLinearChain(nodes, chain.edges)).toThrow(/sink/i);
  });

  it("rejects a wrong node count (a duplicate kind)", () => {
    const nodes = [...chain.nodes, { id: "match2", kind: "match" }];
    expect(() => validateLinearChain(nodes, chain.edges)).toThrow(/match/i);
  });

  it("rejects a branch (a fourth edge off the chain)", () => {
    const edges = [...chain.edges, { id: "e4", source: "ingest", target: "match" }];
    expect(() => validateLinearChain(chain.nodes, edges)).toThrow(/three edges/i);
  });

  it("rejects a wrong order (ingest wired straight to match)", () => {
    const edges: GraphEdge[] = [
      { id: "e1", source: "ingest", target: "match" },
      { id: "e2", source: "normalize", target: "match" },
      { id: "e3", source: "match", target: "sink" },
    ];
    expect(() => validateLinearChain(chain.nodes, edges)).toThrow(/ingest.*normalize/i);
  });

  it("rejects a cycle (an edge back to an earlier node)", () => {
    const edges: GraphEdge[] = [
      { id: "e1", source: "ingest", target: "normalize" },
      { id: "e2", source: "normalize", target: "match" },
      { id: "e3", source: "match", target: "normalize" },
    ];
    expect(() => validateLinearChain(chain.nodes, edges)).toThrow();
  });

  it("rejects a disconnected graph (too few edges)", () => {
    expect(() => validateLinearChain(chain.nodes, chain.edges.slice(0, 2))).toThrow(/three edges/i);
  });

  it("rejects duplicate node ids", () => {
    const nodes: GraphNode[] = [
      { id: "dup", kind: "ingest" },
      { id: "dup", kind: "normalize" },
      { id: "match", kind: "match" },
      { id: "sink", kind: "sink" },
    ];
    expect(() => validateLinearChain(nodes, chain.edges)).toThrow(/node ids.*unique/i);
  });

  it("rejects duplicate edge ids", () => {
    const edges: GraphEdge[] = [
      { id: "same", source: "ingest", target: "normalize" },
      { id: "same", source: "normalize", target: "match" },
      { id: "e3", source: "match", target: "sink" },
    ];
    expect(() => validateLinearChain(chain.nodes, edges)).toThrow(/edge ids.*unique/i);
  });

  it("rejects a self-edge", () => {
    const edges: GraphEdge[] = [
      { id: "e1", source: "ingest", target: "ingest" },
      { id: "e2", source: "normalize", target: "match" },
      { id: "e3", source: "match", target: "sink" },
    ];
    expect(() => validateLinearChain(chain.nodes, edges)).toThrow(/self-edge/i);
  });
});
