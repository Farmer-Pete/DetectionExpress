/**
 * The default detection engine: the example a player starts from. It is the typed
 * twin of `referenceSource` (the in-game editor's default text) — the same PIN
 * brute-force logic, but a real TypeScript module with imported types instead of a
 * runtime source string. It exports `normalize` and `detect` on the current
 * contract: `detect` returns a `Finding[]`, empty when nothing fires.
 *
 * State lives at module scope, so a fresh import replays a run cleanly, the way
 * reloading the source module would. A test that reuses the module drives it in a
 * single pass.
 */
import type { RawKioskV1 } from "./endpoints/kiosk/formats/kiosk-v1";
import type { Finding } from "./finding";

/** The shape Normalize produces from a raw kiosk Event. */
interface NormalizedKiosk {
  account: string;
  terminal: string;
  outcome: "success" | "fail";
}

/** The flat view Detect reads: the normalized payload plus the engine's fields. */
interface KioskDetectView extends NormalizedKiosk {
  id: number;
  ts: number;
  endpoint: string;
}

/** Five wrong PINs on one account inside five minutes (game seconds) is an Attack. */
const WINDOW = 300;
const THRESHOLD = 5;

/** `WINDOW` as "m:ss" for the kv widget (`sim/` stays UI-free: no import from
 *  `src/ui/log/formatters`). Mirrors `referenceSource` and `buildReferenceAlgorithm`'s
 *  identical helper, so the parity trio emits byte-identical context. */
function formatWindowClock(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

const fails = new Map<string, Array<{ id: number; ts: number }>>();
const firing = new Set<string>();

export function normalize(raw: RawKioskV1): NormalizedKiosk {
  return {
    account: raw.acct,
    terminal: raw.term,
    outcome: raw.res === "WRONG_PIN" ? "fail" : "success",
  };
}

export function detect(e: KioskDetectView): Finding[] {
  if (e.outcome !== "fail") {
    return [];
  }
  const f = fails.get(e.account) ?? [];
  f.push({ id: e.id, ts: e.ts });
  const kept = f.filter((x) => x.ts > e.ts - WINDOW);
  fails.set(e.account, kept);
  // The anchor: the first retained fail. It stays fixed while a burst sits inside one
  // window, so the watch and the hit share `eventId` + `reason` and the scorer promotes
  // one row in place. kept always holds the fail we just pushed, so kept[0] exists.
  const anchor = kept[0]?.id ?? e.id;
  const eventIds = kept.map((x) => x.id);
  if (kept.length < THRESHOLD) {
    firing.delete(e.account);
    return [
      {
        alert: { reason: "pin_brute_force", at: e.ts, eventIds },
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
      alert: { reason: "pin_brute_force", at: e.ts, eventIds },
      eventId: anchor,
      subjectType: "account",
      context: [
        {
          type: "kv",
          entries: [
            { label: "wrong PINs", value: kept.length },
            { label: "threshold", value: THRESHOLD },
            { label: "window", value: formatWindowClock(WINDOW) },
          ],
        },
      ],
    },
  ];
}
