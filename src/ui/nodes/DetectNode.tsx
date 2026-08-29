/**
 * The Detect node. It runs the player's `detect` on each Event's flat view and
 * raises Alerts, which the scorer folds against the hidden Attacks. It blinks in
 * the danger color once its own input heat runs high, the same signal the Sink
 * uses, so a backed-up Detect reads the same way anywhere in the Pipeline.
 * Memoized per the React Flow rule.
 */
import { Handle, type NodeProps, Position } from "@xyflow/react";
import { memo } from "react";
import { useGameStore } from "../../game/store";
import { HEAT_STROBE } from "../../game/tuning";

export const DetectNode = memo(function DetectNode(props: NodeProps) {
  const nodeId = props.id;
  const hot = useGameStore((state) => (state.snapshot.nodes[nodeId]?.heat ?? 0) > HEAT_STROBE);

  return (
    <div className={hot ? "node node-detect node-danger" : "node node-detect"}>
      <Handle type="target" position={Position.Left} />
      <div className="node-title">Detect</div>
      <div className="node-sub">raise Alerts</div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
});
