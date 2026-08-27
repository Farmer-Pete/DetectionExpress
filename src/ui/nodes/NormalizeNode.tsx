/**
 * The Normalize node. It runs the player's `normalize` on each raw Event, turning
 * an Endpoint's wire shape into the flat record the Rule reads. Memoized per the
 * React Flow rule.
 */
import { Handle, Position } from "@xyflow/react";
import { memo } from "react";

export const NormalizeNode = memo(function NormalizeNode() {
  return (
    <div className="node node-normalize">
      <Handle type="target" position={Position.Left} />
      <div className="node-title">Normalize</div>
      <div className="node-sub">raw &rarr; record</div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
});
