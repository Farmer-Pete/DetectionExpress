import type { ReactNode } from "react";

/**
 * A labelled bar gauge with a numeric read. The caller supplies the fill color
 * as a palette token, so the gauge itself hard-codes no color. `children`, when
 * given, renders below the track (for example the Correctness counts).
 */
interface GaugeProps {
  label: string;
  value: number;
  max: number;
  unit: string;
  /** A CSS color, always a palette token reference like `var(--a1)`. */
  fill: string;
  /** Decimal places for the readout. Omitted rounds to a whole number. */
  digits?: number;
  children?: ReactNode;
}

export function Gauge(props: GaugeProps) {
  const fraction = Math.max(0, Math.min(1, props.value / props.max));
  const readout =
    props.digits === undefined ? Math.round(props.value) : props.value.toFixed(props.digits);
  return (
    <div className="gauge">
      <div className="gauge-label">{props.label}</div>
      <div className="gauge-value">
        {readout}
        <span className="gauge-unit">{props.unit}</span>
      </div>
      <div className="gauge-track">
        <div
          className="gauge-fill"
          style={{ width: `${fraction * 100}%`, background: props.fill }}
        />
      </div>
      {props.children}
    </div>
  );
}
