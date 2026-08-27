import { describe, expect, it } from "bun:test";
import { type GraphEdge, type GraphNode, validateLinearChain } from "./graph";

const chain: { nodes: GraphNode[]; edges: GraphEdge[] } = {
  nodes: [
    { id: "ingest", kind: "ingest" },
    { id: "sink", kind: "sink" },
  ],
  edges: [{ id: "wire", source: "ingest", target: "sink" }],
};

describe("validateLinearChain", () => {
  it("accepts a single Ingest -> Sink chain and reports its parts", () => {
    const result = validateLinearChain(chain.nodes, chain.edges);
    expect(result).toEqual({ ingestId: "ingest", sinkId: "sink", edgeId: "wire" });
  });

  it("rejects an unknown node kind", () => {
    expect(() =>
      validateLinearChain(
        [
          { id: "ingest", kind: "ingest" },
          { id: "x", kind: "detect" },
        ],
        chain.edges,
      ),
    ).toThrow(/unknown/i);
  });

  it("rejects a missing Ingest or Sink", () => {
    expect(() =>
      validateLinearChain(
        [
          { id: "a", kind: "ingest" },
          { id: "b", kind: "ingest" },
        ],
        [{ id: "wire", source: "a", target: "b" }],
      ),
    ).toThrow();
  });

  it("rejects a branch (more than one edge)", () => {
    expect(() =>
      validateLinearChain(chain.nodes, [
        { id: "wire", source: "ingest", target: "sink" },
        { id: "extra", source: "ingest", target: "sink" },
      ]),
    ).toThrow();
  });

  it("rejects a disconnected graph (no edge)", () => {
    expect(() => validateLinearChain(chain.nodes, [])).toThrow();
  });

  it("rejects an edge that runs Sink -> Ingest", () => {
    expect(() =>
      validateLinearChain(chain.nodes, [{ id: "wire", source: "sink", target: "ingest" }]),
    ).toThrow();
  });
});
