/**
 * Endpoint: a monitored source of telemetry (see `CONTEXT.md`). Each family owns
 * one internal record type, emitted by the actor cast, and each Endpoint is a thin
 * formatter that re-spells that record into its own wire format. Endpoints are pure
 * and shared across Scenarios; a new format is a new file, not an engine change.
 */

export interface Endpoint<Internal = unknown, Raw = unknown> {
  /** The wire format's id, e.g. "kiosk-v1". */
  readonly id: string;
  /** Serialize the internal record into this format. */
  format(record: Internal): Raw;
}
