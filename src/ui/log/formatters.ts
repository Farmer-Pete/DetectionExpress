/**
 * The row formatter registry. The log panel renders one `RingEvent` per row and
 * needs a small view model out of its raw payload. The two shipped endpoints
 * share no field names, so a generic column mapping cannot work; each endpoint
 * gets its own formatter, keyed by the `endpoint` string every `RingEvent`
 * carries. There is no runtime endpoint registry in the sim, so the panel owns
 * this table.
 */
import { sensorCatalogueEntry } from "../../game/sensor-catalogue";
import { isRawGatekeepGate } from "../../sim/endpoints/fare-gate/gatekeep";
import { isRawKioskV1 } from "../../sim/endpoints/kiosk/formats/kiosk-v1";
import type { JsonValue } from "../../sim/finding";
import { placeName, stationName, trainName } from "../../sim/world/world";
import type { SensorKind, WorldLogEvent } from "../../sim/world-log";

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
 *  Shared wherever a game-seconds time reaches the screen: the log panel, the trace
 *  overlay, and the decisions panel. */
export function formatClock(ts: number): string {
  const totalSeconds = Math.max(0, Math.floor(ts));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * A canonical sensor kind's display label, read from `sensors.data` (the single
 * source of truth, GH127-PLAN.md M2) rather than a second hardcoded table. A
 * `SensorKind` id equals its `sensors.data` id, so this lookup is a direct key.
 */
export function sensorLabel(sensor: SensorKind): string {
  return sensorCatalogueEntry(sensor).name;
}

/** One unified-log row: the fields `LogPanel` and `PlaceDialog`'s scoped log render. */
export interface LogRow {
  /** The world-log ring's own id (`WorldLogEvent.id`), never a scored pipeline id. */
  id: number;
  ts: number;
  sensor: SensorKind;
  who: string;
  where: string;
  result: string;
  tone: "ok" | "bad" | "neutral";
}

/**
 * Turn one `WorldLogEvent` into its unified-log row (GH124-PLAN.md Checkpoint 5):
 * extends `formatRow`'s per-endpoint idea from the two scored wire formats to every
 * sensor kind the world ring carries. Exhaustive over `WorldReading["sensor"]` via the
 * switch below, so a future sensor arm is a `tsc` error here, never a silently blank
 * row. Exhaustive over the sensor kinds. It resolves ids through the `world.ts` resolver
 * layer, which throws on an unknown id; the sim only ever feeds it real world ids, so in
 * practice it does not throw.
 *
 * Resolves every world-entity id (a station, a site, or a train) to its display name
 * (GH127-PLAN.md M2), through the shared `world.ts` resolver layer. Telemetry stays
 * raw, per the hard rule: a card, a badge, an operator login, a console host, and a
 * relay destination are never world ids, so they pass through unchanged. `site` reads
 * `placeName` rather than `siteName`, since a door-reader/door-contact/network-relay
 * reading's `site` field can also name the control center (`sensors.data.ts`'s
 * `foundAt.sites` lists `"occ"` alongside the three real sites).
 */
export function toLogRow(ev: WorldLogEvent): LogRow {
  const base = { id: ev.id, ts: ev.ts, sensor: ev.sensor };
  const reading = ev.reading;
  switch (reading.sensor) {
    case "kiosk": {
      const r = reading.reading;
      return {
        ...base,
        who: r.account,
        where: r.terminal,
        result: r.outcome === "success" ? "OK" : "WRONG_PIN",
        tone: r.outcome === "fail" ? "bad" : "ok",
      };
    }
    case "fare-gate": {
      const r = reading.reading;
      return {
        ...base,
        who: r.card,
        where: stationName(r.station),
        result: r.result === "ok" ? "PERMIT" : "REJECT",
        tone: r.result === "reject" ? "bad" : "ok",
      };
    }
    case "tvm": {
      const r = reading.reading;
      return {
        ...base,
        who: r.card,
        where: stationName(r.station),
        result: `+${r.amount}`,
        tone: "ok",
      };
    }
    case "train-tracker": {
      const r = reading.reading;
      return {
        ...base,
        who: trainName(r.train),
        where: stationName(r.station),
        result: r.event === "arr" ? "ARRIVED" : "DEPARTED",
        tone: "neutral",
      };
    }
    case "door-reader": {
      const r = reading.reading;
      return { ...base, who: r.badge, where: placeName(r.site), result: "GRANTED", tone: "ok" };
    }
    case "door-contact": {
      const r = reading.reading;
      return {
        ...base,
        who: "",
        where: placeName(r.site),
        result: r.event === "open" ? "OPENED" : "CLOSED",
        tone: "neutral",
      };
    }
    case "platform-camera": {
      const r = reading.reading;
      return {
        ...base,
        who: "",
        where: stationName(r.station),
        result: `${r.persons} in view`,
        tone: "neutral",
      };
    }
    case "occ-console": {
      const r = reading.reading;
      return {
        ...base,
        who: r.operator,
        where: r.host,
        result: `${r.command} ${r.target}`,
        tone: "neutral",
      };
    }
    case "network-relay": {
      const r = reading.reading;
      return { ...base, who: r.host, where: r.dest, result: `${r.bytes}B`, tone: "neutral" };
    }
  }
}
