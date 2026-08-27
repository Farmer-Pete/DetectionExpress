/**
 * Event: one atomic record entering the Engine (see `CONTEXT.md`). It is a flat
 * typed record whose schema depends on its Endpoint. Slice 0 carries no fields
 * yet, so an Event is an empty record; real fields land in a later slice.
 *
 * The plan wrote `Record<string, unknown>` here, but the repo's anti-slop gate
 * bans that dictionary type. `Record<string, never>` says the same thing for an
 * empty record without tripping the gate, and a later slice replaces it with a
 * named field type anyway.
 */
export type Event = Record<string, never>;

/** Make a fresh Event. Empty for Slice 0. */
export function makeEvent(): Event {
  return {};
}
