/**
 * kiosk-v1: one wire format for the kiosk family. A thin `format` over
 * KioskReading. A later format is another thin `format` over the same record,
 * not a change here.
 */
import type { Endpoint } from "../../endpoint";
import type { KioskReading } from "../internal";

/** The kiosk-v1 wire shape: terse keys, a PIN-check result code. */
export interface RawKioskV1 {
  t: number;
  acct: string;
  term: string;
  res: "WRONG_PIN" | "OK";
}

export const kioskV1: Endpoint<KioskReading, RawKioskV1> = {
  id: "kiosk-v1",
  format: (r) => ({
    t: r.ts,
    acct: r.account,
    term: r.terminal,
    res: r.outcome === "fail" ? "WRONG_PIN" : "OK",
  }),
};

/** A string primitive, by its tag rather than a `typeof` representation check. */
function isString(value: unknown): value is string {
  return !(value instanceof Object) && Object.prototype.toString.call(value) === "[object String]";
}

/**
 * Recognize a kiosk-v1 payload. Not a production boundary check — no engine or
 * Rule code reads the wire payload this way; it is a shared guard the tests
 * (and the test-only reference-Algorithm adapter) use to narrow `payload:
 * unknown` instead of asserting. It checks acct and term are strings too, so a
 * consumer that renders them (the log panel) cannot receive a non-string value.
 */
export function isRawKioskV1(value: unknown): value is RawKioskV1 {
  return (
    value instanceof Object &&
    "t" in value &&
    "acct" in value &&
    isString(value.acct) &&
    "term" in value &&
    isString(value.term) &&
    "res" in value &&
    (value.res === "WRONG_PIN" || value.res === "OK")
  );
}
