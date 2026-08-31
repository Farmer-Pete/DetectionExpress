/**
 * The profiler worker's real logic, kept pure and importable so the tests
 * exercise it without a live worker. It parses the inbound request at the message
 * boundary and adapts a loaded (untyped) player module into the typed ProfilerRule
 * the calibrator prices, validating the module's returns the same way the Detect
 * task does. The worker file itself (worker.ts) is a thin shell over these.
 */
import { parseFindings } from "../../sim/parse-findings";
import { normalizedPayload } from "../../sim/tasks";
import type { LoadedAlgorithm, LoadTarget } from "../algorithm";
import type { ProfilerRule } from "./calibrate";

/**
 * A request to profile one target, with the tab's visibility at dispatch time. The
 * target is discriminated (86-PLAN.md): the Worker imports a served module URL, or
 * blob-imports a source string, exactly as the loader does.
 */
export interface ProfileRequest {
  target: LoadTarget;
  hidden: boolean;
}

/** A string primitive by its tag, not a representation check (mirrors tasks.ts). */
function isString(value: unknown): value is string {
  return Object.prototype.toString.call(value) === "[object String]";
}

/** Parse the discriminated load target off an inbound message, or throw at the boundary. */
function parseTarget(data: unknown): LoadTarget {
  if (data instanceof Object && "kind" in data) {
    if (data.kind === "url" && "url" in data && isString(data.url)) {
      return { kind: "url", url: data.url };
    }
    if (data.kind === "source" && "source" in data && isString(data.source)) {
      return { kind: "source", source: data.source };
    }
  }
  throw new Error('profile target must be { kind: "url", url } or { kind: "source", source }');
}

/** Parse an inbound message into a ProfileRequest, or throw at the boundary. */
export function parseRequest(data: unknown): ProfileRequest {
  if (
    data instanceof Object &&
    "target" in data &&
    "hidden" in data &&
    (data.hidden === true || data.hidden === false)
  ) {
    return { target: parseTarget(data.target), hidden: data.hidden };
  }
  throw new Error("profile request must be { target, hidden: boolean }");
}

/**
 * Adapt a loaded player module into the rule the calibrator prices. The profiler
 * reproduces the run-time Detect boundary exactly, so it parses the module's untyped
 * returns with the same helpers the Detect task uses: `normalizedPayload` accepts
 * any plain object, and `parseFindings` enforces the `Finding[]` contract. A rule
 * that runs at run time therefore profiles without diverging.
 */
export function adaptLoaded(algorithm: LoadedAlgorithm): ProfilerRule {
  return {
    normalize: (raw, endpoint) => normalizedPayload(algorithm.normalize(raw, endpoint)),
    detect: (view) => parseFindings(algorithm.detect(view)),
  };
}
