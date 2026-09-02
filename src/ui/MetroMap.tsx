/**
 * The metro map: the static topology, rendered once in SVG, with the moving actor
 * canvas mounted over it. Lines are offset-parallel polylines in the world.json
 * colors so shared track reads as parallel; stations are nodes; sites and the OCC
 * carry a zone badge (there are NO tinted zone regions); every node draws its sensor
 * chips as quiet static fixtures. Only the fare gate is live in M1 — its taps flash
 * on the canvas layer; the other chips render dim with no behavior.
 *
 * The SVG uses the 960 x 600 design space as its `viewBox` with `xMidYMid meet`, the
 * same fit the canvas applies, so the two layers align exactly.
 */
import { metroLines, metroNodes, type SensorCode } from "../sim/world/layout";
import { world } from "../sim/world/world";
import { sensorIcon } from "./icons/sensor-icons";
import { ActorLayer } from "./metro/ActorLayer";
import { DESIGN_HEIGHT, DESIGN_WIDTH } from "./metro/design";

/** The zone badge fill per zone integer (view notes section 3). */
const ZONE_FILL = ["#3a5a66", "#4a7280", "#5a6f4a", "#7a6a3a", "#8a5a3a"] as const;

const nodes = metroNodes(world);
const lines = metroLines(world);
const sites = nodes.filter((node) => node.kind !== "station");
const occPoint = nodes.find((node) => node.id === world.controlCenter.id)?.point;

export function MetroMap() {
  return (
    <div className="metro-map">
      <svg
        className="metro-svg"
        viewBox={`0 0 ${DESIGN_WIDTH} ${DESIGN_HEIGHT}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label="Metro network map"
      >
        {/* Faint control-network backdrop: a dashed link from each site to the OCC. */}
        {occPoint !== undefined
          ? sites
              .filter((node) => node.kind === "site")
              .map((node) => (
                <line
                  key={`net-${node.id}`}
                  x1={node.point.x}
                  y1={node.point.y}
                  x2={occPoint.x}
                  y2={occPoint.y}
                  className="metro-network-link"
                />
              ))
          : null}

        {/* Offset-parallel line polylines in the world.json colors. A loop line's stops
            already return to the start (the Circle is cen, jct, cen), so its polyline is
            drawn as-is; appending the first point again would add a spurious segment
            between the two offset Central tracks. */}
        {lines.map((line) => (
          <polyline
            key={line.id}
            data-line={line.id}
            className="metro-line"
            points={line.points.map((point) => `${point.x},${point.y}`).join(" ")}
            stroke={line.color}
          />
        ))}

        {/* Sites and the OCC: a zone badge, its name, and its restricted sensor chips. */}
        {sites.map((node) => {
          const zone = node.zone ?? 0;
          return (
            <g key={node.id} data-site={node.id}>
              <rect
                className="metro-badge"
                x={node.point.x - 29}
                y={node.point.y - 15}
                width={58}
                height={30}
                rx={6}
                fill={ZONE_FILL[zone] ?? ZONE_FILL[1]}
              />
              <text className="metro-badge-name" x={node.point.x} y={node.point.y - 2}>
                {node.name}
              </text>
              <text className="metro-badge-zone" x={node.point.x} y={node.point.y + 10}>
                {`Z${zone}`}
              </text>
              {node.chips.map((chip) => (
                <Chip key={chip.id} code={chip.code} x={chip.point.x} y={chip.point.y} />
              ))}
            </g>
          );
        })}

        {/* Stations: a node glyph, its name, and its four public sensor chips. */}
        {nodes
          .filter((node) => node.kind === "station")
          .map((node) => (
            <g key={node.id} data-station={node.id}>
              <circle className="metro-station" cx={node.point.x} cy={node.point.y} r={8} />
              <text className="metro-station-name" x={node.point.x} y={node.point.y - 13}>
                {node.name}
              </text>
              {node.chips.map((chip) => (
                <Chip key={chip.id} code={chip.code} x={chip.point.x} y={chip.point.y} />
              ))}
            </g>
          ))}
      </svg>
      <ActorLayer />
    </div>
  );
}

/** One static sensor chip: a dark 8x8 rounded backing square under its lucide icon,
    tinted with the sensor's color token so the glyph is the primary cue and color
    stays secondary. */
function Chip({ code, x, y }: { code: SensorCode; x: number; y: number }) {
  const { Icon, token } = sensorIcon(code);
  return (
    <g className="metro-chip" data-chip={code}>
      <rect className="metro-chip-bg" x={x - 4} y={y - 4} width={8} height={8} rx={2} />
      <Icon x={x - 3.2} y={y - 3.2} width={6.4} height={6.4} color={token} strokeWidth={2.5} />
    </g>
  );
}
