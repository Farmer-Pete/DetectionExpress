/**
 * The pin-brute-force rule, as a FACTORY. `buildRule()` returns a fresh `EngineRule`
 * each call, so its state (`fails`, `firing`) never leaks between runs or between the
 * engine and the profiler's isolated copy.
 *
 * The logic is the single source of truth for this hunt: the typed composed engine
 * (`default-engine.ts`), the in-process twin (`reference.ts`), and the assembled
 * editor source all derive from this file, so the three stay in parity by
 * construction rather than by hand.
 *
 * On the way up it emits an anchored watch per fail ("N of 5 wrong PINs"), then one
 * hit per burst (a kv widget), grouped by account. The anchor is the first retained
 * fail, so a watch and its hit share `eventId` + `reason` and the scorer promotes one
 * row in place. A benign fumble never reaches the threshold, so it never fires a hit.
 *
 * The constants and the reason string are inlined literals, not cross-file imports,
 * because the assembler drops this file's relative imports when it inlines the rule
 * into the editor source. `rule.test.ts` guards them against drift.
 */
import { withinWindow } from "../../engine/core";
import type { EngineRule } from "../../engine/engine";
import type { DetectView, Finding } from "../../finding";

/** Five wrong PINs on one account inside five minutes (game seconds) is an Attack. */
const WINDOW = 300;
const THRESHOLD = 5;

/** The reason this hunt names. Stays an underscore token, matched by the scorer. */
const REASON = "pin_brute_force";

/** `WINDOW` as "m:ss" for the kv widget. `sim/` stays UI-free, so this lives inline. */
function formatWindowClock(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

/** A string primitive, by its tag rather than a `typeof` representation check. */
function isString(value: unknown): value is string {
  return !(value instanceof Object) && Object.prototype.toString.call(value) === "[object String]";
}

/** Build one fresh pin-brute-force rule instance. */
export function buildRule(): EngineRule {
  const fails = new Map<string, Array<{ id: number; ts: number }>>();
  const firing = new Set<string>();

  return {
    id: "pin-brute-force",
    endpoints: ["kiosk-v1"],
    detect(e: DetectView): Finding[] {
      // `account`/`outcome` ride the DetectView index signature (the normalized
      // payload), so they come off a destructure as `unknown` and get narrowed here.
      const { account, outcome } = e;
      if (!isString(account) || outcome !== "fail") {
        return [];
      }
      const seen = fails.get(account) ?? [];
      seen.push({ id: e.id, ts: e.ts });
      const kept = withinWindow(seen, e.ts, WINDOW);
      fails.set(account, kept);
      // The anchor: the first retained fail. It stays fixed while a burst sits inside
      // one window, so the watch and the hit share `eventId` + `reason` and the scorer
      // promotes one row in place. `kept` always holds the fail we just pushed.
      const anchor = kept[0]?.id ?? e.id;
      const eventIds = kept.map((x) => x.id);
      if (kept.length < THRESHOLD) {
        firing.delete(account);
        return [
          {
            alert: { reason: REASON, at: e.ts, eventIds },
            eventId: anchor,
            subjectType: "account",
            isPartial: true,
            context: [{ type: "text", text: `${kept.length} of ${THRESHOLD} wrong PINs` }],
          },
        ];
      }
      if (firing.has(account)) {
        return []; // one hit per burst; no duplicates
      }
      firing.add(account);
      return [
        {
          alert: { reason: REASON, at: e.ts, eventIds },
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
    },
  };
}
