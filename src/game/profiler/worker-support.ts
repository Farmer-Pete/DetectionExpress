/**
 * The profiler worker's real logic, kept pure and importable so the tests
 * exercise it without a live worker. It parses the inbound request at the message
 * boundary and adapts a loaded (untyped) player module into the typed ProfilerRule
 * the calibrator prices, validating the module's returns the same way the Match
 * task does. The worker file itself (worker.ts) is a thin shell over these.
 */
import { parseFindings } from "../../sim/parse-findings";
import { normalizedPayload } from "../../sim/tasks";
import type { LoadedAlgorithm } from "../algorithm";
import type { ProfilerRule } from "./calibrate";

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

/**
 * Adapt a loaded player module into the rule the calibrator prices. The profiler
 * reproduces the run-time Match boundary exactly, so it parses the module's untyped
 * returns with the same helpers the Match task uses: `normalizedPayload` accepts
 * any plain object, and `parseFindings` enforces the `Finding[]` contract. A rule
 * that runs at run time therefore profiles without diverging.
 */
export function adaptLoaded(algorithm: LoadedAlgorithm): ProfilerRule {
  return {
    normalize: (raw) => normalizedPayload(algorithm.normalize(raw)),
    match: (view) => parseFindings(algorithm.match(view)),
  };
}
