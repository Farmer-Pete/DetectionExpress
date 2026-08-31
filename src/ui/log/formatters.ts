/**
 * The row formatter registry. The log panel renders one `RingEvent` per row and
 * needs a small view model out of its raw payload. The two shipped endpoints
 * share no field names, so a generic column mapping cannot work; each endpoint
 * gets its own formatter, keyed by the `endpoint` string every `RingEvent`
 * carries. There is no runtime endpoint registry in the sim, so the panel owns
 * this table.
 */
import { isRawGatekeepGate } from "../../sim/endpoints/fare-gate/gatekeep";
import { isRawKioskV1 } from "../../sim/endpoints/kiosk/formats/kiosk-v1";
import type { JsonValue } from "../../sim/finding";

export interface RowView {
  /** Subject: account or card. */
  who: string;
  /** Location: terminal, station. */
  where: string;
  /** Outcome: OK, WRONG_PIN, PERMIT, REJECT. */
  result: string;
  tone: "ok" | "bad" | "neutral";
}

type RowFormatter = (raw: JsonValue) => RowView;

/** The unknown-endpoint and shape-mismatch fallback: the raw payload as compact JSON. */
function fallback(endpoint: string, raw: JsonValue): RowView {
  return { who: "", where: endpoint, result: JSON.stringify(raw), tone: "neutral" };
}

const FORMATTERS: Record<string, RowFormatter> = {
  "kiosk-v1": (raw) => {
    // isRawKioskV1 establishes the full contract, including that acct and term are
    // strings, so a payload with a non-string acct or term degrades to the JSON fallback
    // here rather than rendering an object as a React child and throwing.
    if (!isRawKioskV1(raw)) {
      return fallback("kiosk-v1", raw);
    }
    return {
      who: raw.acct,
      where: raw.term,
      result: raw.res,
      tone: raw.res === "WRONG_PIN" ? "bad" : "ok",
    };
  },
  "gatekeep-turnkey": (raw) => {
    if (!isRawGatekeepGate(raw)) {
      return fallback("gatekeep-turnkey", raw);
    }
    return {
      who: raw.MEDIA_SERIAL,
      where: raw.STATION_CODE,
      result: raw.GATE_RESULT,
      tone: raw.GATE_RESULT === "REJECT" ? "bad" : "ok",
    };
  },
};

/**
 * Format one Event's raw payload for the log row. Dispatches on `endpoint`, then
 * narrows `raw` with that endpoint's own type guard. An unknown endpoint or a
 * shape mismatch both degrade to the JSON fallback. Never throws.
 */
export function formatRow(endpoint: string, raw: JsonValue): RowView {
  const formatter = FORMATTERS[endpoint];
  if (formatter === undefined) {
    return fallback(endpoint, raw);
  }
  return formatter(raw);
}

/** `ts` is game seconds. Formats as an mm:ss clock; the formatter never reads real time.
 *  Shared by the log panel and the trace overlay, the two places a `RingEvent`'s time
 *  reaches the screen. */
export function formatClock(ts: number): string {
  const totalSeconds = Math.max(0, Math.floor(ts));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
