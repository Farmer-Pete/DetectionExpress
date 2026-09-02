/**
 * The Gatekeep fare-gate endpoint: a dumb formatter over the fare-gate family's
 * internal record. The rider emits a `FareGateReading`; this re-spells it into the
 * Gatekeep TurnKey wire shape from `src/game/sensors.data.ts`. This slice ships one
 * vendor format; VeriTap and RailSense (with their cents and code conversions) are
 * later tickets.
 */
import type { Endpoint } from "../endpoint";

/**
 * The fare-gate family's internal record, matching the `normalizedExample` in
 * `sensors.data.ts`. Balance is a non-negative integer in whole currency units; the
 * emitted balance is the balance after a tap-in's charge.
 */
export interface FareGateReading {
  /** Game seconds. */
  ts: number;
  card: string;
  station: string;
  line: string;
  direction: "in" | "out";
  result: "ok" | "reject";
  balance: number;
}

/** The Gatekeep TurnKey wire shape: an ISO timestamp and loud SCREAMING_SNAKE keys. */
export interface RawGatekeepGate {
  EVENT_TIME: string;
  MEDIA_SERIAL: string;
  STATION_CODE: string;
  LINE_ID: string;
  DIRECTION: "ENTRY" | "EXIT";
  GATE_RESULT: "PERMIT" | "REJECT";
  STORED_VALUE: number;
}

/**
 * Game-second 0 anchored to a fixed wall date, so `EVENT_TIME` is a real ISO 8601
 * string yet reads no wall clock. It matches the example date in `sensors.data.ts`.
 * `new Date(explicitMs)` takes its argument, so this is pure and deterministic
 * (ARCHITECTURE rule 8 bans reading wall time, not formatting game time).
 */
const EPOCH_ANCHOR = 1756433643;

export const gatekeepGate: Endpoint<FareGateReading, RawGatekeepGate> = {
  id: "gatekeep-turnkey",
  format: (reading) => ({
    EVENT_TIME: new Date((EPOCH_ANCHOR + reading.ts) * 1000).toISOString(),
    MEDIA_SERIAL: reading.card,
    STATION_CODE: reading.station.toUpperCase(),
    LINE_ID: reading.line.toUpperCase(),
    DIRECTION: reading.direction === "in" ? "ENTRY" : "EXIT",
    GATE_RESULT: reading.result === "ok" ? "PERMIT" : "REJECT",
    STORED_VALUE: reading.balance,
  }),
};

/**
 * A string primitive. The tag check alone also passes a boxed `new String("x")`,
 * which is an object, so the `instanceof String` clause excludes it.
 */
function isString(value: unknown): value is string {
  return Object.prototype.toString.call(value) === "[object String]" && !(value instanceof String);
}

/** A finite number, so a domain check can narrow it before a comparison. */
function isFiniteNumber(value: unknown): value is number {
  return Number.isFinite(value);
}

/**
 * Recognize a Gatekeep TurnKey payload. Unlike the presence-only kiosk guard, it
 * validates every field's type and each union value, so a wrong-typed or
 * out-of-union field is rejected.
 */
export function isRawGatekeepGate(value: unknown): value is RawGatekeepGate {
  return (
    value instanceof Object &&
    "EVENT_TIME" in value &&
    isString(value.EVENT_TIME) &&
    "MEDIA_SERIAL" in value &&
    isString(value.MEDIA_SERIAL) &&
    "STATION_CODE" in value &&
    isString(value.STATION_CODE) &&
    "LINE_ID" in value &&
    isString(value.LINE_ID) &&
    "DIRECTION" in value &&
    (value.DIRECTION === "ENTRY" || value.DIRECTION === "EXIT") &&
    "GATE_RESULT" in value &&
    (value.GATE_RESULT === "PERMIT" || value.GATE_RESULT === "REJECT") &&
    "STORED_VALUE" in value &&
    isFiniteNumber(value.STORED_VALUE) &&
    Number.isInteger(value.STORED_VALUE) &&
    value.STORED_VALUE >= 0
  );
}
