/**
 * The auth family's internal record. It owns the login semantics once; each auth
 * Endpoint is a thin `format` over it. Generated from a GenContext, so the same
 * seed and intent always yield the same record.
 */
import { Factory } from "fishery";
import type { GenContext } from "../endpoint";

export interface AuthRecord {
  /** Game seconds. */
  ts: number;
  account: string;
  sourceIp: string;
  outcome: "success" | "fail";
}

/** The auth record factory. `generateAuth` fills it from the seeded context. */
const authRecordFactory = Factory.define<AuthRecord>(() => ({
  ts: 0,
  account: "unknown",
  sourceIp: "0.0.0.0",
  outcome: "success",
}));

/**
 * Render one realistic auth record from the intent. The identity, time, and
 * outcome come straight from the intent; the source ip is a seeded field value,
 * so the record reads like real telemetry without leaking Ground truth.
 */
export function generateAuth(ctx: GenContext): AuthRecord {
  return authRecordFactory.build({
    ts: ctx.ts,
    account: ctx.account,
    sourceIp: ctx.faker.internet.ipv4(),
    outcome: ctx.outcome,
  });
}
