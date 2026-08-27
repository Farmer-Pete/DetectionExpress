/**
 * Graph validation. The store graph is the single source of topology; the engine
 * reads it, validates it, and only then allocates channels and starts tasks.
 *
 * Slice 0 supports exactly one linear chain: a single Ingest to a single Sink
 * over one edge. Anything else (an unknown kind, a missing node, a branch, a
 * disconnected node, a backward edge) throws a clear error before allocation.
 */

/** A node as the validator needs it: an id and its kind. */
export interface GraphNode {
  id: string;
  kind: string;
}

/** An edge as the validator needs it: an id and its endpoints. */
export interface GraphEdge {
  id: string;
  source: string;
  target: string;
}

/** The validated wiring the engine builds from. */
export interface LinearChain {
  ingestId: string;
  sinkId: string;
  edgeId: string;
}

const KNOWN_KINDS = new Set(["ingest", "sink"]);

export function validateLinearChain(nodes: GraphNode[], edges: GraphEdge[]): LinearChain {
  for (const node of nodes) {
    if (!KNOWN_KINDS.has(node.kind)) {
      throw new Error(`Graph has an unknown node kind: "${node.kind}" on node "${node.id}".`);
    }
  }

  const ingests = nodes.filter((node) => node.kind === "ingest");
  const sinks = nodes.filter((node) => node.kind === "sink");
  if (ingests.length !== 1 || sinks.length !== 1 || nodes.length !== 2) {
    throw new Error(
      `Slice 0 needs exactly one Ingest and one Sink, got ${ingests.length} Ingest(s) and ${sinks.length} Sink(s) across ${nodes.length} node(s).`,
    );
  }

  const ingest = ingests[0];
  const sink = sinks[0];
  if (!ingest || !sink) {
    throw new Error("Graph is missing an Ingest or a Sink.");
  }

  if (edges.length !== 1) {
    throw new Error(`Slice 0 needs exactly one edge, got ${edges.length}.`);
  }

  const edge = edges[0];
  if (!edge || edge.source !== ingest.id || edge.target !== sink.id) {
    throw new Error("The single edge must run from the Ingest to the Sink.");
  }

  return { ingestId: ingest.id, sinkId: sink.id, edgeId: edge.id };
}
