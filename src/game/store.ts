/**
 * The store bridges the sim to React. It holds the graph topology (the single
 * source of wiring), the Sink's control, and the latest sim snapshot. Fast sim
 * state lives here, not in useState, so a snapshot update re-renders only the
 * gauges through selectors, not the whole graph.
 */
import {
  applyEdgeChanges,
  applyNodeChanges,
  type Edge,
  type Node,
  type OnEdgesChange,
  type OnNodesChange,
} from "@xyflow/react";
import { create } from "zustand";
import type { GraphEdge, GraphNode } from "../sim/graph";
import { emptySnapshot, type SimSnapshot } from "../sim/snapshot";
import { ARRIVAL_RATE } from "./tuning";

/**
 * NodeMeta lives on React Flow's `node.data`, its natural home for node config.
 * A `type` (not an interface) so it satisfies React Flow's `Record<string,
 * unknown>` data constraint. This holds the node's config, NOT the Events
 * flowing through the Pipeline.
 */
type NodeMeta = {
  kind: "ingest" | "sink";
  /** events/sec: lambda for Ingest, mu for Sink (Part 0 scaffolding). */
  rate: number;
};

type PipelineNode = Node<NodeMeta>;

/** The starting mu for the Sink slider (Part 0 scaffolding). */
const INITIAL_SINK_RATE = 10;

interface GameState {
  nodes: PipelineNode[];
  edges: Edge[];
  snapshot: SimSnapshot;
  onNodesChange: OnNodesChange<PipelineNode>;
  onEdgesChange: OnEdgesChange;
  setSnapshot: (snapshot: SimSnapshot) => void;
  /** Write the Sink's mu. Part 0 scaffolding: the slider drives this. */
  setSinkRate: (rate: number) => void;
}

const initialNodes: PipelineNode[] = [
  {
    id: "ingest",
    type: "ingest",
    position: { x: 80, y: 140 },
    data: { kind: "ingest", rate: ARRIVAL_RATE },
  },
  {
    id: "sink",
    type: "sink",
    position: { x: 460, y: 140 },
    data: { kind: "sink", rate: INITIAL_SINK_RATE },
  },
];

const initialEdges: Edge[] = [
  { id: "ingest-sink", source: "ingest", target: "sink", type: "stream" },
];

export const useGameStore = create<GameState>((set) => ({
  nodes: initialNodes,
  edges: initialEdges,
  snapshot: emptySnapshot(),
  onNodesChange: (changes) => set((state) => ({ nodes: applyNodeChanges(changes, state.nodes) })),
  onEdgesChange: (changes) => set((state) => ({ edges: applyEdgeChanges(changes, state.edges) })),
  setSnapshot: (snapshot) => set({ snapshot }),
  setSinkRate: (rate) =>
    set((state) => ({
      nodes: state.nodes.map((node) =>
        node.data.kind === "sink" ? { ...node, data: { ...node.data, rate } } : node,
      ),
    })),
}));

/**
 * A plain-TypeScript rate accessor for the engine. The Sink task calls it live
 * each Event, so a slider drag takes effect on the next Event. Part 0 does not
 * harden it against bad values (the slider is bounded scaffolding).
 */
export function getRate(nodeId: string): number {
  const node = useGameStore.getState().nodes.find((candidate) => candidate.id === nodeId);
  return node ? node.data.rate : 0;
}

/** The store graph, mapped to the validator's shape for the engine. */
export function getGraph(): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const state = useGameStore.getState();
  return {
    nodes: state.nodes.map((node) => ({ id: node.id, kind: node.data.kind })),
    edges: state.edges.map((edge) => ({ id: edge.id, source: edge.source, target: edge.target })),
  };
}
