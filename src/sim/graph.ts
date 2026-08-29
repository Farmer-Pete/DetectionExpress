/**
 * Graph validation. The store graph is the single source of topology; the engine
 * reads it, validates it, and only then allocates channels and starts tasks.
 *
 * Slice 1 locks one shape: the ordered linear chain ingest -> normalize -> detect
 * -> sink (four nodes, three edges). Anything else (an unknown kind, a missing
 * node, a branch, a cycle, a wrong count, a duplicate id, a backward edge) throws
 * a clear error before allocation.
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

/** The validated wiring the engine builds from: ids in chain order. */
export interface LinearChain {
  /** Node ids, ordered ingest, normalize, detect, sink. */
  nodeIds: string[];
  /** Edge ids, ordered along the chain. */
  edgeIds: string[];
}

/** The chain's kinds, in the order the pipeline runs them. */
const CHAIN_ORDER = ["ingest", "normalize", "detect", "sink"] as const;
const KNOWN_KINDS = new Set<string>(CHAIN_ORDER);

export function validateLinearChain(nodes: GraphNode[], edges: GraphEdge[]): LinearChain {
  for (const node of nodes) {
    if (!KNOWN_KINDS.has(node.kind)) {
      throw new Error(`Graph has an unknown node kind: "${node.kind}" on node "${node.id}".`);
    }
  }

  if (new Set(nodes.map((node) => node.id)).size !== nodes.length) {
    throw new Error("Graph node ids must be unique.");
  }
  if (new Set(edges.map((edge) => edge.id)).size !== edges.length) {
    throw new Error("Graph edge ids must be unique.");
  }
  for (const edge of edges) {
    if (edge.source === edge.target) {
      throw new Error(`Edge "${edge.id}" is a self-edge, which is not a linear chain.`);
    }
  }

  // Exactly one node of each chain kind, in the fixed order.
  const ordered: GraphNode[] = [];
  for (const kind of CHAIN_ORDER) {
    const of = nodes.filter((node) => node.kind === kind);
    if (of.length !== 1) {
      throw new Error(`The chain needs exactly one ${kind} node, but found ${of.length}.`);
    }
    const only = of[0];
    if (only) {
      ordered.push(only);
    }
  }
  if (nodes.length !== CHAIN_ORDER.length) {
    throw new Error(`The chain needs exactly four nodes, but found ${nodes.length}.`);
  }
  if (edges.length !== CHAIN_ORDER.length - 1) {
    throw new Error(`The chain needs exactly three edges, but found ${edges.length}.`);
  }

  // Each consecutive pair must be wired in order. A missing edge here catches a
  // wrong order, a branch that dropped a real edge, or a backward cycle.
  const edgeIds: string[] = [];
  for (let i = 0; i < ordered.length - 1; i++) {
    const from = ordered[i];
    const to = ordered[i + 1];
    if (!from || !to) {
      continue;
    }
    const edge = edges.find(
      (candidate) => candidate.source === from.id && candidate.target === to.id,
    );
    if (!edge) {
      throw new Error(
        `The edge from the ${from.kind} to the ${to.kind} is missing or misdirected.`,
      );
    }
    edgeIds.push(edge.id);
  }

  return { nodeIds: ordered.map((node) => node.id), edgeIds };
}
