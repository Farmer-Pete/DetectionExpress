/**
 * The store bridges the sim to React. It holds the graph topology (the single
 * source of wiring), the player's Algorithm source, the level seed, the current
 * error, and the latest sim snapshot. Fast sim state lives here, not in useState,
 * so a snapshot update re-renders only the gauges through selectors, not the whole
 * graph.
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
import { referenceSource } from "../sim/scenarios/kiosk-pin-attack/reference";
import { emptySnapshot, type SimSnapshot } from "../sim/snapshot";
import type { RuleErrorInfo } from "./run-controller";
import { LEVEL_SEED } from "./tuning";

/**
 * NodeMeta lives on React Flow's `node.data`, its natural home for node config.
 * A `type` (not an interface) so it satisfies React Flow's `Record<string,
 * unknown>` data constraint. This holds the node's config, NOT the Events flowing
 * through the Pipeline.
 */
type NodeMeta = {
  kind: "ingest" | "normalize" | "match" | "sink";
};

type PipelineNode = Node<NodeMeta>;

interface GameState {
  nodes: PipelineNode[];
  edges: Edge[];
  snapshot: SimSnapshot;
  /** The player's Algorithm source. The editor edits it; the run controller loads it. */
  source: string;
  /** The deterministic level seed for the run. */
  seed: number;
  /** The current run or Rule error, or null. The editor shows it. */
  error: RuleErrorInfo | null;
  /**
   * True while an external source drives the run (the dev host watches a file), so
   * the editor locks its textarea. Generic, not dev-specific: the static build
   * carries it too, always false and harmless.
   */
  sourceLocked: boolean;
  onNodesChange: OnNodesChange<PipelineNode>;
  onEdgesChange: OnEdgesChange;
  setSnapshot: (snapshot: SimSnapshot) => void;
  setAlgorithmSource: (source: string) => void;
  setError: (error: RuleErrorInfo | null) => void;
  setSourceLocked: (locked: boolean) => void;
}

const initialNodes: PipelineNode[] = [
  { id: "ingest", type: "ingest", position: { x: 40, y: 140 }, data: { kind: "ingest" } },
  { id: "normalize", type: "normalize", position: { x: 260, y: 140 }, data: { kind: "normalize" } },
  { id: "match", type: "match", position: { x: 480, y: 140 }, data: { kind: "match" } },
  { id: "sink", type: "sink", position: { x: 700, y: 140 }, data: { kind: "sink" } },
];

const initialEdges: Edge[] = [
  { id: "e1", source: "ingest", target: "normalize", type: "stream" },
  { id: "e2", source: "normalize", target: "match", type: "stream" },
  { id: "e3", source: "match", target: "sink", type: "stream" },
];

export const useGameStore = create<GameState>((set) => ({
  nodes: initialNodes,
  edges: initialEdges,
  snapshot: emptySnapshot(),
  source: referenceSource,
  seed: LEVEL_SEED,
  error: null,
  sourceLocked: false,
  onNodesChange: (changes) => set((state) => ({ nodes: applyNodeChanges(changes, state.nodes) })),
  onEdgesChange: (changes) => set((state) => ({ edges: applyEdgeChanges(changes, state.edges) })),
  setSnapshot: (snapshot) => set({ snapshot }),
  setAlgorithmSource: (source) => set({ source }),
  setError: (error) => set({ error }),
  setSourceLocked: (locked) => set({ sourceLocked: locked }),
}));

/** The store graph, mapped to the validator's shape for the engine. */
export function getGraph(): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const state = useGameStore.getState();
  return {
    nodes: state.nodes.map((node) => ({ id: node.id, kind: node.data.kind })),
    edges: state.edges.map((edge) => ({ id: edge.id, source: edge.source, target: edge.target })),
  };
}
