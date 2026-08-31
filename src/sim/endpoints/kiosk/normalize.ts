/**
 * The kiosk family's normalizers, keyed by endpoint id. One engine parses many wire
 * formats, so each endpoint owns its normalizer here and the engine dispatches by
 * endpoint id. `normalizeKiosk` parses one raw kiosk-v1 payload — an untyped value off
 * the wire — into the normalized domain shape the pin-brute-force rule reads.
 *
 * The endpoint id below is the literal `"kiosk-v1"`, not `kioskV1.id`, and the payload
 * is parsed here with an inlined tag guard rather than a cross-file `isRawKioskV1`: the
 * assembler inlines this file into the editor source with its relative imports dropped,
 * so it must carry no cross-file value reference. `normalize.test.ts` asserts the literal
 * still equals `kioskV1.id`, so the two cannot drift.
 */
import type { Normalizer } from "../../engine/engine";

/** The shape Normalize produces from a raw kiosk Event. */
export interface NormalizedKiosk {
  account: string;
  terminal: string;
  outcome: "success" | "fail";
}

/** A string primitive, by its tag rather than a `typeof` representation check. */
function isString(value: unknown): value is string {
  return !(value instanceof Object) && Object.prototype.toString.call(value) === "[object String]";
}

/**
 * Parse one raw kiosk-v1 payload into the normalized domain shape. The payload arrives
 * untyped off the pipeline, so this validates its fields at the seam before it trusts
 * them; a malformed payload throws rather than fabricating a record.
 */
export function normalizeKiosk(raw: unknown): NormalizedKiosk {
  if (!(raw instanceof Object) || !("acct" in raw && "term" in raw && "res" in raw)) {
    throw new Error("a kiosk-v1 payload must carry acct, term, and res.");
  }
  const { acct, term, res } = raw;
  if (!isString(acct) || !isString(term)) {
    throw new Error("a kiosk-v1 payload's acct and term must be strings.");
  }
  return { account: acct, terminal: term, outcome: res === "WRONG_PIN" ? "fail" : "success" };
}

/** The kiosk normalizers the registry gathers, keyed by endpoint id. */
export const normalizers: Record<string, Normalizer> = {
  "kiosk-v1": normalizeKiosk,
};
