/**
 * The reference Algorithm, in two forms with the same logic.
 *
 * `referenceSource` is the editor's default text and what the browser run loads.
 * It imports lodash by absolute URL, the way a player would. `referenceAlgorithm`
 * is the in-process twin the deterministic tests run: the same logic with no
 * import, so it needs no network and no loader. Both raise one Alert per Attack.
 */
import type { Alert } from "../../alert";
import type { RawAuthV1 } from "../../endpoints/auth/formats/auth-v1";
import { BRUTE_FORCE_REASON } from "./attacks";

/** The editor default and the browser run. Imports lodash by URL, like a player. */
export const referenceSource = `import _ from "https://esm.sh/lodash@4.17.21";
export function normalize(raw) {
  return {
    user: raw.u,
    sourceIp: raw.src,
    outcome: _.startsWith(_.toLower(raw.res), "fail") ? "fail" : "success",
  };
}
const fails = {};
const firing = {};
export function match(e) {
  const WINDOW = 300; // 5 minutes in game seconds
  if (e.outcome !== "fail") return null;
  const f = (fails[e.user] ??= []);
  f.push({ id: e.id, ts: e.ts });
  fails[e.user] = f.filter((x) => x.ts > e.ts - WINDOW);
  if (fails[e.user].length < 5) {
    firing[e.user] = false;
    return null;
  }
  if (firing[e.user]) return null; // one Alert per burst; no duplicates
  firing[e.user] = true;
  return { reason: "brute_force", at: e.ts, events: fails[e.user].map((x) => x.id) };
}
`;

/** The player's shape after Normalize. */
interface NormalizedAuth {
  user: string;
  sourceIp: string;
  outcome: "success" | "fail";
}

/** The flat view Match hands the Rule: the normalized payload plus engine fields. */
interface MatchView extends NormalizedAuth {
  id: number;
  ts: number;
  endpoint: string;
}

export interface ReferenceAlgorithm {
  normalize(raw: RawAuthV1): NormalizedAuth;
  match(e: MatchView): Alert | null;
}

/**
 * The in-process twin. State lives per instance, so a fresh instance replays the
 * same run cleanly, the way reloading the source module would. The engine test
 * builds a fresh one per run to keep run-twice determinism honest.
 */
export function buildReferenceAlgorithm(): ReferenceAlgorithm {
  const fails = new Map<string, Array<{ id: number; ts: number }>>();
  const firing = new Set<string>();
  const WINDOW = 300; // 5 minutes in game seconds
  const THRESHOLD = 5;

  return {
    normalize(raw) {
      return {
        user: raw.u,
        sourceIp: raw.src,
        outcome: raw.res.toLowerCase().startsWith("fail") ? "fail" : "success",
      };
    },
    match(e) {
      if (e.outcome !== "fail") {
        return null;
      }
      const f = fails.get(e.user) ?? [];
      f.push({ id: e.id, ts: e.ts });
      const kept = f.filter((x) => x.ts > e.ts - WINDOW);
      fails.set(e.user, kept);
      if (kept.length < THRESHOLD) {
        firing.delete(e.user);
        return null;
      }
      if (firing.has(e.user)) {
        return null; // one Alert per burst; no duplicates
      }
      firing.add(e.user);
      return { reason: BRUTE_FORCE_REASON, at: e.ts, events: kept.map((x) => x.id) };
    },
  };
}

export const referenceAlgorithm = buildReferenceAlgorithm();
