/**
 * A labelled bar gauge with a numeric read. The caller supplies the fill color
 * as a palette token, so the gauge itself hard-codes no color.
 */
interface GaugeProps {
  label: string;
  value: number;
  max: number;
  unit: string;
  /** A CSS color, always a palette token reference like `var(--a1)`. */
  fill: string;
}

export function Gauge(props: GaugeProps) {
  const fraction = Math.max(0, Math.min(1, props.value / props.max));
  return (
    <div className="gauge">
      <div className="gauge-label">{props.label}</div>
      <div className="gauge-value">
        {Math.round(props.value)}
        <span className="gauge-unit">{props.unit}</span>
      </div>
      <div className="gauge-track">
        <div
          className="gauge-fill"
          style={{ width: `${fraction * 100}%`, background: props.fill }}
        />
      </div>
    </div>
  );
}
