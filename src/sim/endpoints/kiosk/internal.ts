/**
 * The kiosk family's one internal record. It owns the account sign-in semantics
 * once, and each kiosk Endpoint is a thin `format` over it, the way the fare-gate
 * family owns `FareGateReading`. `AccountKioskReading` moved here from
 * `world-reading.ts` (GH102): the `WorldReading` kiosk arm now imports it, and the
 * actor path (account rider, PIN attacker) emits it directly. `outcome` is widened
 * to `"success" | "fail"`, so a benign sign-in, a benign fumble, and an attacker's
 * wrong PIN are all one record. `station` names the station whose kiosk was used;
 * it is not on the kiosk-v1 wire.
 *
 * `generateKiosk` and the fishery factory are the legacy field-roll path, kept only
 * until the corpus moves onto actors (GH102 D9). They roll no station, so the
 * factory defaults it to a placeholder that never reaches the wire.
 */
import { Factory } from "fishery";
import type { GenContext } from "../endpoint";

export interface AccountKioskReading {
  /** Game seconds. */
  ts: number;
  account: string;
  /** The station whose kiosk was used. Not on the kiosk-v1 wire. */
  station: string;
  /** A deterministic per-kiosk terminal id, e.g. `"K1"`. */
  terminal: string;
  outcome: "success" | "fail";
}

/** The kiosk terminals an account kiosk visitor may sign in at; drawn per visit. */
export const KIOSK_TERMINALS: readonly string[] = ["K1", "K2"];

/**
 * The legacy kiosk reading factory (GH102: retire with the corpus rebuild). It
 * defaults `station` to a placeholder because the field-roll path has no station;
 * the kiosk-v1 wire ignores it, so the placeholder never reaches a payload.
 */
const kioskReadingFactory = Factory.define<AccountKioskReading>(() => ({
  ts: 0,
  account: "unknown",
  station: "unknown",
  terminal: "KIOSK-00",
  outcome: "success",
}));

/**
 * Render one realistic kiosk reading from the intent. The identity, time, and
 * outcome come straight from the intent; the terminal id is a seeded field
 * value, so the reading reads like real telemetry without leaking Ground truth.
 * Legacy field-roll path, retired with the corpus rebuild (GH102 D9).
 */
export function generateKiosk(ctx: GenContext): AccountKioskReading {
  const terminalNumber = ctx.faker.number.int({ min: 0, max: 99 }).toString().padStart(2, "0");
  return kioskReadingFactory.build({
    ts: ctx.ts,
    account: ctx.account,
    terminal: `KIOSK-${terminalNumber}`,
    outcome: ctx.outcome,
  });
}
