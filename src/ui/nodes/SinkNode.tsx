/**
 * The Sink node. It drains the wire: every Event that reaches it is processed,
 * which drives the Throughput gauge. The Sink no longer has a rate slider, because
 * the player now owns the node work; the Sink just drains. It still blinks in the
 * danger color when its own input backs up. Memoized per the React Flow rule.
 */
import { Handle, type NodeProps, Position } from "@xyflow/react";
import { memo } from "react";
import { useGameStore } from "../../game/store";
import { HEAT_STROBE } from "../../game/tuning";

export const SinkNode = memo(function SinkNode(props: NodeProps) {
  const nodeId = props.id;
  // Blink in the danger color once the Sink's own heat runs high.
  const hot = useGameStore((state) => (state.snapshot.nodes[nodeId]?.heat ?? 0) > HEAT_STROBE);

  return (
    <div className={hot ? "node node-sink node-danger" : "node node-sink"}>
      <Handle type="target" position={Position.Left} />
      <div className="node-title">Sink</div>
      <div className="node-sub">drains</div>
    </div>
  );
});
