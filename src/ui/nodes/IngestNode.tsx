/**
 * The Ingest node. It is the source: it emits Events into the wire at the arrival
 * rate. A source has no input Backlog, so it never heats up and stays calm the
 * whole run. Memoized per the React Flow rule.
 */
import { Handle, Position } from "@xyflow/react";
import { memo } from "react";

export const IngestNode = memo(function IngestNode() {
  return (
    <div className="node node-ingest">
      <div className="node-title">Ingest</div>
      <div className="node-sub">events in</div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
});
