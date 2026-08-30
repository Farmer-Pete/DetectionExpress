/**
 * The reference Algorithm, in two forms with the same logic.
 *
 * `referenceSource` is the editor's default text and what the browser run loads.
 * It imports lodash by absolute URL, the way a player would. `referenceAlgorithm`
 * is the in-process twin the deterministic tests run: the same logic with no
 * import, so it needs no network and no loader. Both emit anchored watches on the
 * way up ("N of 5 wrong PINs"), then one hit per burst, grouped by account.
 */

import type { RawKioskV1 } from "../../endpoints/kiosk/formats/kiosk-v1";
import type { Finding } from "../../finding";
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
export function detect(e) {
  const WINDOW = 300; // 5 minutes in game seconds
  const THRESHOLD = 5;
  if (e.outcome !== "fail") return [];
  const f = (fails[e.account] ??= []);
  f.push({ id: e.id, ts: e.ts });
  const kept = f.filter((x) => x.ts > e.ts - WINDOW);
  fails[e.account] = kept;
  const anchor = kept[0].id; // first retained fail; stable across a dense burst
  const eventIds = kept.map((x) => x.id);
  if (kept.length < THRESHOLD) {
    firing[e.account] = false;
    return [{
      alert: { reason: "pin_brute_force", at: e.ts, eventIds },
      eventId: anchor,
      subjectType: "account",
      isPartial: true,
      context: [{ type: "text", text: kept.length + " of " + THRESHOLD + " wrong PINs" }],
    }];
  }
  if (firing[e.account]) return []; // one hit per burst; no duplicates
  firing[e.account] = true;
  return [{
    alert: { reason: "pin_brute_force", at: e.ts, eventIds },
    eventId: anchor,
    subjectType: "account",
  }];
}
`;

/** The player's shape after Normalize. */
interface NormalizedKiosk {
  account: string;
  terminal: string;
  outcome: "success" | "fail";
}

/** The flat view Detect hands the Rule: the normalized payload plus engine fields. */
interface KioskDetectView extends NormalizedKiosk {
  id: number;
  ts: number;
  endpoint: string;
}

export interface ReferenceAlgorithm {
  normalize(raw: RawKioskV1): NormalizedKiosk;
  detect(e: KioskDetectView): Finding[];
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
    detect(e) {
      if (e.outcome !== "fail") {
        return [];
      }
      const f = fails.get(e.account) ?? [];
      f.push({ id: e.id, ts: e.ts });
      const kept = f.filter((x) => x.ts > e.ts - WINDOW);
      fails.set(e.account, kept);
      // The anchor: the first retained fail. Stable while a burst sits inside one
      // window, so the watch and the hit share `eventId` + `reason` and the scorer
      // promotes one row in place. kept always holds the just-pushed fail.
      const anchor = kept[0]?.id ?? e.id;
      const eventIds = kept.map((x) => x.id);
      if (kept.length < THRESHOLD) {
        firing.delete(e.account);
        return [
          {
            alert: { reason: PIN_BRUTE_FORCE_REASON, at: e.ts, eventIds },
            eventId: anchor,
            subjectType: "account",
            isPartial: true,
            context: [{ type: "text", text: `${kept.length} of ${THRESHOLD} wrong PINs` }],
          },
        ];
      }
      if (firing.has(e.account)) {
        return []; // one hit per burst; no duplicates
      }
      firing.add(e.account);
      return [
        {
          alert: { reason: PIN_BRUTE_FORCE_REASON, at: e.ts, eventIds },
          eventId: anchor,
          subjectType: "account",
        },
      ];
    },
  };
}

export const referenceAlgorithm = buildReferenceAlgorithm();
