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
        edgesFocusable={false}
        deleteKeyCode={null}
        // Keep nodes interactive (elementsSelectable stays on) so the Sink slider
        // receives pointer events. Turning it off sets pointer-events:none on the
        // node, and the slider goes dead. Dragging is still off via nodesDraggable.
        // Slice 0 is a fixed two-node display. The canvas does not pan or zoom,
        // so a slider drag never moves the graph. Later slices can re-enable this.
        panOnDrag={false}
        panOnScroll={false}
        zoomOnScroll={false}
        zoomOnDoubleClick={false}
        fitView
        minZoom={0.5}
        maxZoom={1.5}
      >
        <Background gap={20} color="var(--line)" />
      </ReactFlow>
    </div>
  );
}
