/**
 * The fixed Pipeline topology. Slice 1 locks one shape, the linear chain ingest ->
 * normalize -> detect -> sink, and the visual editor is gone, so the wiring no longer
 * lives in editable store state. It lives here as a plain, sim-shaped constant that the
 * engine reads through `getGraph()`.
 *
 * The values are `readonly` and sim-shaped (`GraphNode` / `GraphEdge`), with no React
 * Flow positions or types. `getGraph()` maps them to fresh objects each call, so no
 * consumer can mutate the shared topology.
 */
import type { GraphEdge, GraphNode } from "../sim/graph";

/** The four Nodes of the locked chain, in run order. */
export const PIPELINE_NODES: readonly GraphNode[] = [
  { id: "ingest", kind: "ingest" },
  { id: "normalize", kind: "normalize" },
  { id: "detect", kind: "detect" },
  { id: "sink", kind: "sink" },
];

/** The three edges wiring the chain, in run order. */
export const PIPELINE_EDGES: readonly GraphEdge[] = [
  { id: "e1", source: "ingest", target: "normalize" },
  { id: "e2", source: "normalize", target: "detect" },
  { id: "e3", source: "detect", target: "sink" },
];
