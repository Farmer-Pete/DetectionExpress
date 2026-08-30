/**
 * Shared helpers for the fare-gate-rush tests, so the gatekeep payload guard and
 * the tick conversion live in one place instead of a copy per test file.
 */
import { GAME_SECONDS_PER_TICK } from "../../../game/tuning";
import { isRawGatekeepGate, type RawGatekeepGate } from "../../endpoints/fare-gate/gatekeep";
import type { PipeEvent } from "../../event";

/** Read an Event's gatekeep-turnkey payload, narrowing at the boundary. */
export function raw(ev: PipeEvent): RawGatekeepGate {
  if (!isRawGatekeepGate(ev.payload)) {
    throw new Error("expected a gatekeep-turnkey payload");
  }
  return ev.payload;
}

/** Every event's (0-based) tick, from its ts in game seconds. */
export function tickOf(ev: PipeEvent): number {
  return ev.ts / GAME_SECONDS_PER_TICK;
}
