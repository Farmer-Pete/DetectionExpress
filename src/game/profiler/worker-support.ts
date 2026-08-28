/**
 * The profiler worker's real logic, kept pure and importable so bun tests
 * exercise it without a live worker. It parses the inbound request at the message
 * boundary and adapts a loaded (untyped) player module into the typed ProfilerRule
 * the calibrator prices, validating the module's returns the same way the Match
 * task does. The worker file itself (worker.ts) is a thin shell over these.
 */
import type { Alert } from "../../sim/alert";
import type { RawKioskV1 } from "../../sim/endpoints/kiosk/formats/kiosk-v1";
import type { LoadedAlgorithm } from "../algorithm";
import type { ProfilerRule } from "./calibrate";
import type { MatchView, NormalizedKiosk } from "./rules";

/** A request to profile one source, with the tab's visibility at dispatch time. */
export interface ProfileRequest {
  source: string;
  hidden: boolean;
}

/** A string primitive by its tag, not a representation check (mirrors tasks.ts). */
function isString(value: unknown): value is string {
  return Object.prototype.toString.call(value) === "[object String]";
}

/** Parse an inbound message into a ProfileRequest, or throw at the boundary. */
export function parseRequest(data: unknown): ProfileRequest {
  if (
    data instanceof Object &&
    "source" in data &&
    isString(data.source) &&
    "hidden" in data &&
    (data.hidden === true || data.hidden === false)
  ) {
    return { source: data.source, hidden: data.hidden };
  }
  throw new Error("profile request must be { source: string, hidden: boolean }");
}

/** Parse a player's normalize result into the domain shape, or throw. */
function parseNormalized(value: unknown): NormalizedKiosk {
  if (
    value instanceof Object &&
    "account" in value &&
    isString(value.account) &&
    "terminal" in value &&
    isString(value.terminal) &&
    "outcome" in value &&
    (value.outcome === "success" || value.outcome === "fail")
  ) {
    return { account: value.account, terminal: value.terminal, outcome: value.outcome };
  }
  throw new Error("normalize must return { account, terminal, outcome }");
}

/** A structural Alert check by shape and type (mirrors the Match task's parser). */
function isAlert(value: unknown): value is Alert {
  return (
    value instanceof Object &&
    "reason" in value &&
    isString(value.reason) &&
    "at" in value &&
    Number.isFinite(value.at) &&
    "events" in value &&
    Array.isArray(value.events) &&
    value.events.every((event) => Number.isFinite(event))
  );
}

/** Parse a player's match result into Alert | null, or throw on a bad shape. */
function parseAlert(value: unknown): Alert | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (isAlert(value)) {
    return value;
  }
  throw new Error("match must return an Alert, null, or undefined");
}

/**
 * Adapt a loaded player module into the typed rule the calibrator prices. The
 * profiler reproduces the run-time Match view exactly, so it parses the module's
 * untyped returns at this boundary, just as the Match task does at run time.
 */
export function adaptLoaded(algorithm: LoadedAlgorithm): ProfilerRule {
  return {
    normalize: (raw: RawKioskV1): NormalizedKiosk => parseNormalized(algorithm.normalize(raw)),
    match: (view: MatchView): Alert | null => parseAlert(algorithm.match(view)),
  };
}
