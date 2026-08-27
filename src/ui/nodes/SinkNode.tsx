/**
 * The Sink node. It drains the wire; its input Backlog is what backs up. It reads
 * its live rate and heat from the store through selectors, so the graph array
 * does not change when the player drags the slider.
 *
 * Part 0 scaffolding: the range slider and the Sink's `rate` field exist only to
 * fake a slow node for Slice 0. Part 1 gives players real node code and removes
 * both. The `nodrag` class keeps the slider from panning the canvas.
 */
import { Handle, type NodeProps, Position } from "@xyflow/react";
import { memo } from "react";
import { useGameStore } from "../../game/store";
import { HEAT_STROBE, SINK_MIN_RATE } from "../../game/tuning";

export const SinkNode = memo(function SinkNode(props: NodeProps) {
  const nodeId = props.id;
  const rate = useGameStore(
    (state) => state.nodes.find((node) => node.id === nodeId)?.data.rate ?? 0,
  );
  const setSinkRate = useGameStore((state) => state.setSinkRate);
  // Blink in the danger color once the Sink's own heat runs high.
  const hot = useGameStore((state) => (state.snapshot.nodes[nodeId]?.heat ?? 0) > HEAT_STROBE);

  return (
    <div className={hot ? "node node-sink node-danger" : "node node-sink"}>
      <Handle type="target" position={Position.Left} />
      <div className="node-title">Sink</div>
      <div className="node-sub">
        &micro; {rate.toFixed(1)}
        <span className="node-unit">/s</span>
      </div>
      {/* Part 0 scaffolding: the mu slider. Removed in Part 1. */}
      <input
        className="nodrag node-slider"
        type="range"
        min={SINK_MIN_RATE}
        max={20}
        step={0.5}
        value={rate}
        onChange={(event) => setSinkRate(Number(event.target.value))}
      />
    </div>
  );
});
