/**
 * auth-v1: one wire format for the auth family. A thin `format` over AuthRecord.
 * A later format is another thin `format` over the same record, not a change here.
 */
import type { Endpoint } from "../../endpoint";
import type { AuthRecord } from "../internal";

/** The auth-v1 wire shape: terse keys, uppercase outcome. */
export interface RawAuthV1 {
  t: number;
  u: string;
  src: string;
  res: "FAILURE" | "SUCCESS";
}

export const authV1: Endpoint<AuthRecord, RawAuthV1> = {
  id: "auth-v1",
  format: (r) => ({
    t: r.ts,
    u: r.account,
    src: r.sourceIp,
    res: r.outcome === "fail" ? "FAILURE" : "SUCCESS",
  }),
};

/**
 * Recognize an auth-v1 payload on the wire. The envelope carries `payload:
 * unknown`, so a reader narrows it here at the boundary instead of asserting.
 */
export function isRawAuthV1(value: unknown): value is RawAuthV1 {
  return (
    value instanceof Object &&
    "t" in value &&
    "u" in value &&
    "src" in value &&
    "res" in value &&
    (value.res === "FAILURE" || value.res === "SUCCESS")
  );
}
