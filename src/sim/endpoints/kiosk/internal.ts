/**
 * The kiosk family's one internal record. It owns the account sign-in semantics
 * once, and each kiosk Endpoint is a thin `format` over it, the way the fare-gate
 * family owns `FareGateReading`. The actor path (account rider, PIN attacker) emits
 * it directly. `outcome` covers a benign sign-in, a benign fumble, and an attacker's
 * wrong PIN as one record. `station` names the station whose kiosk was used; it is
 * not on the kiosk-v1 wire.
 */

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
