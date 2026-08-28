/**
 * The reference Algorithm, in two forms with the same logic.
 *
 * `referenceSource` is the editor's default text and what the browser run loads.
 * It imports lodash by absolute URL, the way a player would. `referenceAlgorithm`
 * is the in-process twin the deterministic tests run: the same logic with no
 * import, so it needs no network and no loader. Both raise one Alert per Attack.
 */
import type { Alert } from "../../alert";
import type { RawKioskV1 } from "../../endpoints/kiosk/formats/kiosk-v1";
import { PIN_BRUTE_FORCE_REASON } from "./attacks";

/** The editor default and the browser run. Imports lodash by URL, like a player. */
export const referenceSource = `import _ from "https://esm.sh/lodash@4.17.21";
export function normalize(raw) {
  return {
    account: raw.acct,
    terminal: raw.term,
    outcome: raw.res === "WRONG_PIN" ? "fail" : "success",
  };
}
const fails = {};
const firing = {};
export function match(e) {
  const WINDOW = 300; // 5 minutes in game seconds
  if (e.outcome !== "fail") return null;
  const f = (fails[e.account] ??= []);
  f.push({ id: e.id, ts: e.ts });
  fails[e.account] = f.filter((x) => x.ts > e.ts - WINDOW);
  if (fails[e.account].length < 5) {
    firing[e.account] = false;
    return null;
  }
  if (firing[e.account]) return null; // one Alert per burst; no duplicates
  firing[e.account] = true;
  return { reason: "pin_brute_force", at: e.ts, events: fails[e.account].map((x) => x.id) };
}
`;

/** The player's shape after Normalize. */
interface NormalizedKiosk {
  account: string;
  terminal: string;
  outcome: "success" | "fail";
}

/** The flat view Match hands the Rule: the normalized payload plus engine fields. */
interface MatchView extends NormalizedKiosk {
  id: number;
  ts: number;
  endpoint: string;
}

export interface ReferenceAlgorithm {
  normalize(raw: RawKioskV1): NormalizedKiosk;
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
        account: raw.acct,
        terminal: raw.term,
        outcome: raw.res === "WRONG_PIN" ? "fail" : "success",
      };
    },
    match(e) {
      if (e.outcome !== "fail") {
        return null;
      }
      const f = fails.get(e.account) ?? [];
      f.push({ id: e.id, ts: e.ts });
      const kept = f.filter((x) => x.ts > e.ts - WINDOW);
      fails.set(e.account, kept);
      if (kept.length < THRESHOLD) {
        firing.delete(e.account);
        return null;
      }
      if (firing.has(e.account)) {
        return null; // one Alert per burst; no duplicates
      }
      firing.add(e.account);
      return { reason: PIN_BRUTE_FORCE_REASON, at: e.ts, events: kept.map((x) => x.id) };
    },
  };
}

export const referenceAlgorithm = buildReferenceAlgorithm();
