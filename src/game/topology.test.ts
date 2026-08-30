import { describe, expect, it } from "vitest";
import { validateLinearChain } from "../sim/graph";
import { getGraph } from "./store";

describe("topology", () => {
  it("getGraph returns the four-node chain the validator accepts", () => {
    const { nodes, edges } = getGraph();
    // validateLinearChain throws on any wrong shape, so a clean return is the assertion.
    const chain = validateLinearChain(nodes, edges);
    expect(chain.nodeIds).toEqual(["ingest", "normalize", "detect", "sink"]);
    expect(chain.edgeIds).toEqual(["e1", "e2", "e3"]);
  });

  it("maps to the ids and kinds the old store produced", () => {
    const { nodes, edges } = getGraph();
    expect(nodes).toEqual([
      { id: "ingest", kind: "ingest" },
      { id: "normalize", kind: "normalize" },
      { id: "detect", kind: "detect" },
      { id: "sink", kind: "sink" },
    ]);
    expect(edges).toEqual([
      { id: "e1", source: "ingest", target: "normalize" },
      { id: "e2", source: "normalize", target: "detect" },
      { id: "e3", source: "detect", target: "sink" },
    ]);
  });

  it("returns a fresh array each call, so mutating one call does not leak into the next", () => {
    const first = getGraph();
    first.nodes.push({ id: "rogue", kind: "ingest" });
    first.edges.pop();
    const second = getGraph();
    expect(second.nodes).toHaveLength(4);
    expect(second.edges).toHaveLength(3);
  });

  it("returns fresh node and edge objects, so mutating a field does not leak into the next", () => {
    const first = getGraph();
    const firstNode = first.nodes[0];
    const firstEdge = first.edges[0];
    if (!firstNode || !firstEdge) {
      throw new Error("expected a populated chain");
    }
    firstNode.kind = "sink";
    firstEdge.target = "rogue";
    const second = getGraph();
    expect(second.nodes[0]).toEqual({ id: "ingest", kind: "ingest" });
    expect(second.edges[0]).toEqual({ id: "e1", source: "ingest", target: "normalize" });
  });
});
