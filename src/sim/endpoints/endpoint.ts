/**
 * Endpoint: a monitored source of telemetry (see `CONTEXT.md`). Each family owns
 * one internal record type, generated once, and each Endpoint is a thin formatter
 * that re-spells that record into its own wire format. Endpoints are pure and
 * shared across Scenarios; a new format is a new file, not an engine change.
 */
import type { Faker } from "@faker-js/faker";

/**
 * GenContext: the seeded inputs a generator draws from, plus the intent the
 * record must render. `rng` and `faker` are both seeded from the level seed, so
 * generation is deterministic. `outcome` is the intent; the record renders it.
 */
export interface GenContext {
  /** Seeded uniform in [0, 1). */
  rng: () => number;
  /** Seeded field values (ips, names). */
  faker: Faker;
  /** Game seconds: the scheduled time for this record. */
  ts: number;
  account: string;
  /** The intent the record renders. */
  outcome: "success" | "fail";
}

export interface Endpoint<Internal = unknown, Raw = unknown> {
  /** The wire format's id, e.g. "kiosk-v1". */
  readonly id: string;
  /** Serialize the internal record into this format. */
  format(record: Internal): Raw;
}
