/**
 * The fixed Pipeline topology. Slice 1 locks one shape, the linear chain ingest ->
 * normalize -> detect -> sink, and the visual editor is gone, so the wiring no longer
 * lives in editable store state. It lives here as a plain, sim-shaped constant that the
 * engine reads through `getGraph()`.
 *
 * The values are `readonly` and sim-shaped (`GraphNode` / `GraphEdge`), with no React
 * Flow positions or types. Each element is frozen, and `getGraph()` maps them to fresh
 * objects each call, so no consumer can mutate the shared topology through the constant
 * or through the returned graph.
 */
import type { GraphEdge, GraphNode } from "../sim/graph";

/** The four Nodes of the locked chain, in run order. */
export const PIPELINE_NODES: readonly Readonly<GraphNode>[] = [
  Object.freeze({ id: "ingest", kind: "ingest" }),
  Object.freeze({ id: "normalize", kind: "normalize" }),
  Object.freeze({ id: "detect", kind: "detect" }),
  Object.freeze({ id: "sink", kind: "sink" }),
];

/** The three edges wiring the chain, in run order. */
export const PIPELINE_EDGES: readonly Readonly<GraphEdge>[] = [
  Object.freeze({ id: "e1", source: "ingest", target: "normalize" }),
  Object.freeze({ id: "e2", source: "normalize", target: "detect" }),
  Object.freeze({ id: "e3", source: "detect", target: "sink" }),
];
