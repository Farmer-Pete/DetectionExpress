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
  /**
   * Adds a heartbeat pulse to the fill (#38 juice item 2). Reduced-motion-guarded
   * in CSS; the fill's danger color already carries the severity, so the pulse
   * only enhances it. The caller decides which gauges opt in (only Queue, at
   * `severityLevel(...) === "danger"`; Compute never pulses — `Hud.test.tsx`).
   */
  pulse?: boolean;
  children?: ReactNode;
}

export function Gauge(props: GaugeProps) {
  // A NaN or Infinity would render as text and break the fill width, so it reads
  // as zero. A live gauge should never receive one, but this keeps a bad value
  // from reaching the DOM.
  const value = Number.isFinite(props.value) ? props.value : 0;
  const fraction = Math.max(0, Math.min(1, value / props.max));
  const readout = props.digits === undefined ? Math.round(value) : value.toFixed(props.digits);
  return (
    <div className="gauge">
      <div className="gauge-label">{props.label}</div>
      <div className="gauge-value">
        {readout}
        <span className="gauge-unit">{props.unit}</span>
      </div>
      <div className="gauge-track">
        <div
          className={props.pulse ? "gauge-fill gauge-fill-pulse" : "gauge-fill"}
          data-testid="gauge-fill"
          style={{ width: `${fraction * 100}%`, background: props.fill }}
        />
      </div>
      {props.children}
    </div>
  );
}
