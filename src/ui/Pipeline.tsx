/**
 * The Pipeline canvas. React Flow stays controlled: nodes and edges live in the
 * store, not in component state. Node and edge types are declared at module
 * scope so their identity is stable across renders. Slice 0 locks the topology,
 * so the player cannot drag, connect, select, or delete anything.
 */
import { Background, type EdgeTypes, type NodeTypes, ReactFlow } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useGameStore } from "../game/store";
import { StreamEdge } from "./edges/StreamEdge";
import { IngestNode } from "./nodes/IngestNode";
import { SinkNode } from "./nodes/SinkNode";

const nodeTypes: NodeTypes = { ingest: IngestNode, sink: SinkNode };
const edgeTypes: EdgeTypes = { stream: StreamEdge };

export function Pipeline() {
  const nodes = useGameStore((state) => state.nodes);
  const edges = useGameStore((state) => state.edges);
  const onNodesChange = useGameStore((state) => state.onNodesChange);
  const onEdgesChange = useGameStore((state) => state.onEdgesChange);

  return (
    <div className="pipeline">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        edgesFocusable={false}
        deleteKeyCode={null}
        fitView
        minZoom={0.5}
        maxZoom={1.5}
      >
        <Background gap={20} color="var(--line)" />
      </ReactFlow>
    </div>
  );
}
