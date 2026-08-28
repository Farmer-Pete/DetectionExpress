/**
 * The kiosk family's internal record. It owns the PIN-check semantics once; each
 * kiosk Endpoint is a thin `format` over it. Generated from a GenContext, so the
 * same seed and intent always yield the same record.
 */
import { Factory } from "fishery";
import type { GenContext } from "../endpoint";

export interface KioskReading {
  /** Game seconds. */
  ts: number;
  account: string;
  terminal: string;
  outcome: "success" | "fail";
}

/** The kiosk reading factory. `generateKiosk` fills it from the seeded context. */
const kioskReadingFactory = Factory.define<KioskReading>(() => ({
  ts: 0,
  account: "unknown",
  terminal: "KIOSK-00",
  outcome: "success",
}));

/**
 * Render one realistic kiosk reading from the intent. The identity, time, and
 * outcome come straight from the intent; the terminal id is a seeded field
 * value, so the reading reads like real telemetry without leaking Ground truth.
 */
export function generateKiosk(ctx: GenContext): KioskReading {
  const terminalNumber = ctx.faker.number.int({ min: 0, max: 99 }).toString().padStart(2, "0");
  return kioskReadingFactory.build({
    ts: ctx.ts,
    account: ctx.account,
    terminal: `KIOSK-${terminalNumber}`,
    outcome: ctx.outcome,
  });
}
